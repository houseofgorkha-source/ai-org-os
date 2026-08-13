import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelProvider } from './broker.ts';

/**
 * Real Anthropic Messages API adapter (Slice 1.5, CLAUDE.md §11).
 *
 * `ModelBroker.call` and the executor's loop (executor.ts) are synchronous
 * end-to-end — no `await` anywhere in that chain — and Node has no built-in
 * synchronous HTTP client. `broker.ts` already shells out synchronously for
 * `git` and `shell.exec`, so this does the same for the API call via `curl`
 * rather than making the executor/kernel/broker chain async. No new runtime
 * dependency; the `ModelProvider` interface (broker.ts) is unchanged.
 *
 * The API key is passed to curl through a `-K` config file, not argv, so it
 * never appears in a process listing.
 *
 * ---
 *
 * Action delivery uses the Messages API's native tool-use, not free-text
 * convention-following. Four real model runs (aios-harness-XXh05t,
 * QZbz7X, and two more) each showed a first turn that correctly read a file,
 * then a SECOND turn with zero parsed actions — not even a malformed one —
 * meaning the model was not attempting `CALL` syntax at all, not merely
 * getting its formatting wrong. Asking a chat-tuned model to hand-format an
 * ad hoc "CALL tool scope {json}" text line is asking it to imitate a
 * protocol by convention; nothing constrains what it actually emits.
 *
 * Anthropic's `tools` schema does constrain it: the API validates the
 * model's structured call against a JSON schema before it's ever returned.
 * This adapter still returns plain `{ text }` (the `ModelProvider` interface,
 * and therefore executor.ts's parser and every scripted-provider test, is
 * UNCHANGED) — but that text is now built by this code from an
 * already-schema-validated `tool_use` block, via `JSON.stringify`, which
 * can never produce the embedded-raw-newline or malformed-JSON shapes the
 * old free-text path was vulnerable to. The model gets a real `done`/`refuse`
 * action instead of hoping it writes the bare word "DONE" unprompted.
 */

export interface AnthropicProviderConfig {
  readonly name: string;
  readonly model: string;
  /** Defaults to ANTHROPIC_API_KEY. */
  readonly apiKeyEnvVar?: string;
  readonly baseUrl?: string;
}

/** Registered tool ids (slice01.ts TOOLS) exposed as native Anthropic tools. Anthropic tool names may not contain '.'. */
const TOOL_API_NAME: Record<string, string> = {
  'fs.read': 'fs_read', 'fs.write': 'fs_write', 'shell.exec': 'shell_exec', 'git.commit': 'git_commit',
};
const API_NAME_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_API_NAME).map(([toolId, apiName]) => [apiName, toolId]),
);

function toolDefs(): unknown[] {
  return [
    ...Object.entries(TOOL_API_NAME).map(([toolId, apiName]) => ({
      name: apiName,
      description: `Invoke the ${toolId} tool. 'scope' is the capability scope, e.g. "workspace://src/app.js". `
        + `'args' carries the tool's parameters: {"path":"..."} for fs.read; {"path":"...","content":"..."} for `
        + `fs.write; {"cmd":"..."} for shell.exec; {"message":"..."} for git.commit.`,
      input_schema: {
        type: 'object',
        properties: { scope: { type: 'string' }, args: { type: 'object' } },
        required: ['scope', 'args'],
      },
    })),
    {
      name: 'done',
      description: 'Call this when — and only when — the stated objective has actually been completed by your prior tool calls. Reading a file is never sufficient on its own.',
      input_schema: { type: 'object', properties: {} },
    },
    {
      name: 'refuse',
      description: 'Call this instead of guessing if the objective is genuinely ambiguous or unsafe to proceed with.',
      input_schema: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
    },
  ];
}

export interface AnthropicContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly input?: { readonly scope?: string; readonly args?: unknown; readonly reason?: string };
}

/** Deterministic, code-side translation — never the model's free text — so the result is always well-formed. Exported for direct test coverage (no live API call). */
export function toCallText(blocks: readonly AnthropicContentBlock[]): string {
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  const done = toolUses.find((b) => b.name === 'done');
  if (done) return 'DONE';
  const refuse = toolUses.find((b) => b.name === 'refuse');
  if (refuse) return `REFUSE ${refuse.input?.reason ?? 'ambiguous objective'}`;
  if (toolUses.length > 0) {
    return toolUses
      .map((b) => {
        const toolId = API_NAME_TOOL[b.name ?? ''] ?? b.name ?? 'unknown';
        return `CALL ${toolId} ${b.input?.scope ?? ''} ${JSON.stringify(b.input?.args ?? {})}`;
      })
      .join('\n');
  }
  return blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

export function anthropicProvider(cfg: AnthropicProviderConfig): ModelProvider {
  const envVar = cfg.apiKeyEnvVar ?? 'ANTHROPIC_API_KEY';
  const apiKey = process.env[envVar];
  if (!apiKey) throw new Error(`${envVar} is not set`);
  const url = cfg.baseUrl ?? 'https://api.anthropic.com/v1/messages';

  return {
    name: cfg.name,
    complete(req) {
      const dir = mkdtempSync(join(tmpdir(), 'aios-anthropic-'));
      try {
        const bodyFile = join(dir, 'body.json');
        const configFile = join(dir, 'curl.cfg');
        writeFileSync(bodyFile, JSON.stringify({
          model: cfg.model,
          max_tokens: req.maxOutputTokens,
          messages: [{ role: 'user', content: req.prompt }],
          tools: toolDefs(),
        }), 'utf8');
        writeFileSync(configFile, [
          `url = "${url}"`,
          `header = "x-api-key: ${apiKey}"`,
          `header = "anthropic-version: 2023-06-01"`,
          `header = "content-type: application/json"`,
          `data-binary = "@${bodyFile.replace(/\\/g, '/')}"`,
          `silent`,
          `show-error`,
          `fail-with-body`,
        ].join('\n'), 'utf8');

        let out: string;
        try {
          out = execFileSync('curl', ['-K', configFile], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
        } catch (e) {
          const err = e as { stdout?: string; stderr?: string; message: string };
          throw new Error(`anthropic request failed: ${err.stderr || err.stdout || err.message}`);
        }

        const parsed = JSON.parse(out) as {
          content?: AnthropicContentBlock[];
          usage?: { input_tokens: number; output_tokens: number };
          error?: { type: string; message: string };
        };
        if (parsed.error) throw new Error(`anthropic error: ${parsed.error.type}: ${parsed.error.message}`);
        const text = toCallText(parsed.content ?? []);
        const usage = parsed.usage ?? { input_tokens: 0, output_tokens: 0 };
        return { text, inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

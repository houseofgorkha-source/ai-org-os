import type {
  ContextRecipe, ContextManifest, RenderedLayer, WorkUnit, AuthorityTier, Artifact,
} from './types.ts';
import { estimateTokens, hashOf, nextId, now, sha256 } from './util.ts';

/**
 * Context Compiler + rendering contract (Note 01 §14, §14a / E2).
 *
 * Deterministic pipeline, no model call. Memory is a source reachable ONLY from
 * here — gates, the capability broker, kernel validation, policy composition,
 * and budget enforcement have no path to it (Note 05 §7).
 */

export interface MemoryRecord {
  readonly id: string;
  readonly version: string;
  readonly kind: 'knowledge' | 'objective' | 'heuristic' | 'reference' | 'preference';
  readonly statement: string;
  readonly scopeSelector: string;
  readonly assertedAgainstCommit: string;
  readonly status: 'active' | 'superseded' | 'expired' | 'retracted';
}

/** Slice 01 runs with an EMPTY store. T-E2 asserts compilation still succeeds. */
export class MemoryStore {
  private records: MemoryRecord[] = [];
  add(r: MemoryRecord): void { this.records.push(r); }
  active(): readonly MemoryRecord[] { return this.records.filter((r) => r.status === 'active'); }
  size(): number { return this.records.length; }
}

export interface LayerSource {
  /** Returns null when the layer has nothing to contribute (`on_miss` applies). */
  gather(unit: WorkUnit, ctx: GatherContext): { body: string; provenance: string; sourceVersion: string; units?: number } | null;
}

export interface GatherContext {
  readonly repoRoot: string;
  readonly headCommit: string;
  readonly memory: MemoryStore;
  readonly priorFailure: string | null;
  readonly readFile: (rel: string) => string | null;
  readonly listFiles: () => readonly string[];
  /** model_judged gate execution only: the artifact under review, so a verifier layer can render its segments — never set for an ordinary mechanical-change attempt. */
  readonly reviewArtifact?: Artifact | null;
}

const AUTHORITY: Record<string, AuthorityTier> = {
  role_prompt: 'contract',
  objective: 'contract',
  target_files: 'ground-truth',
  neighbourhood: 'ground-truth',
  existing_tests: 'ground-truth',
  conventions: 'policy',
  runtime_surface: 'policy',
  prior_attempt_evidence: 'contract',
  memory: 'advisory',
  diff_under_review: 'ground-truth',
};

export interface CompileResult {
  readonly rendered: string;
  readonly manifest: ContextManifest;
}

export class ContextCompiler {
  private readonly sources: Map<string, LayerSource>;
  constructor(sources: Map<string, LayerSource>) { this.sources = sources; }

  compile(unit: WorkUnit, recipe: ContextRecipe, ctx: GatherContext): CompileResult {
    // 2. GATHER / 3. TRANSFORM
    const gathered: RenderedLayer[] = [];
    const memoryManifest = {
      candidateSet: [] as { id: string; version: string }[],
      included: [] as { id: string; version: string; mark: 'verified' | 'unverified' }[],
      dropped: [] as { id: string; version: string; reason: string }[],
    };

    for (const layer of recipe.layers) {
      if (layer.name === 'memory') {
        const built = this.buildMemoryLayer(unit, layer.maxTokens, ctx, memoryManifest);
        if (built) gathered.push(built);
        else if (layer.required) throw new Error(`context compilation failed: required layer '${layer.name}' missing`);
        continue;
      }
      const src = this.sources.get(layer.name);
      const got = src ? src.gather(unit, ctx) : null;
      if (!got) {
        if (layer.required && layer.onMiss === 'fail') {
          throw new Error(`context compilation failed: required layer '${layer.name}' missing`);
        }
        continue; // on_miss: omit
      }
      const authority = AUTHORITY[layer.name] ?? 'policy';
      let body = got.body;
      let truncated: RenderedLayer['truncated'];
      const totalUnits = got.units ?? body.split('\n').length;
      if (estimateTokens(body) > layer.maxTokens) {
        // 6. BUDGET — truncate and ANNOUNCE (E2.3). Never silent.
        const keepChars = layer.maxTokens * 4;
        const kept = body.slice(0, keepChars);
        const keptUnits = kept.split('\n').length;
        body = kept;
        truncated = { omitted: Math.max(0, totalUnits - keptUnits), of: totalUnits, unit: 'lines', policy: `layer cap ${layer.maxTokens} tokens` };
      }
      gathered.push({
        name: layer.name, authority, provenance: got.provenance,
        marks: truncated ? ['truncated'] : [], body,
        tokens: estimateTokens(body), truncated,
      });
    }

    // 7a. RENDER — the contract. Every block labelled; nothing outside a block.
    const rendered = gathered.map(renderLayer).join('\n');

    // 8. MANIFEST — assembledHash over the RENDERED output (E2 rule 4)
    const manifest: ContextManifest = {
      id: nextId('cm'),
      recipeRef: `${recipe.id}@${recipe.version}`,
      layers: gathered.map((l) => ({
        name: l.name, hash: hashOf(l.body), sourceVersion: l.provenance,
        tokens: l.tokens, truncated: Boolean(l.truncated),
      })),
      memory: memoryManifest,
      totalTokens: gathered.reduce((a, l) => a + l.tokens, 0),
      assembledHash: sha256(rendered),
      compiledAt: now(),
    };
    return { rendered, manifest };
  }

  private buildMemoryLayer(
    unit: WorkUnit, maxTokens: number, ctx: GatherContext,
    mm: { candidateSet: { id: string; version: string }[]; included: { id: string; version: string; mark: 'verified' | 'unverified' }[]; dropped: { id: string; version: string; reason: string }[] },
  ): RenderedLayer | null {
    const active = ctx.memory.active();
    for (const r of active) mm.candidateSet.push({ id: r.id, version: r.version });
    if (active.length === 0) return null;   // required:false, on_miss:omit ⇒ T-E2
    const lines: string[] = [];
    for (const r of active) {
      const stale = r.assertedAgainstCommit !== ctx.headCommit;
      const mark: 'verified' | 'unverified' = stale ? 'unverified' : 'verified';
      mm.included.push({ id: r.id, version: r.version, mark });
      lines.push(`[${r.kind} · scope ${r.scopeSelector} · ${mark.toUpperCase()}]\n  ${r.statement}`);
    }
    let body = lines.join('\n');
    if (estimateTokens(body) > maxTokens) body = body.slice(0, maxTokens * 4);
    return { name: 'memory', authority: 'advisory', provenance: active.map((r) => `${r.id}@${r.version}`).join(','), marks: [], body, tokens: estimateTokens(body) };
  }
}

const RULE = '─'.repeat(70);

export function renderLayer(l: RenderedLayer): string {
  const marks = l.marks.length ? ' · ' + l.marks.join(' · ') : '';
  const head = `── ${l.name} · ${l.authority} · ${l.provenance}${marks} ${RULE}`.slice(0, 100);
  const trunc = l.truncated
    ? `\n── truncated: ${l.truncated.omitted} of ${l.truncated.of} ${l.truncated.unit} omitted (${l.truncated.policy}) ──`
    : '';
  return `${head}\n${l.body}${trunc}\n${RULE}\n`;
}

/** Parses rendered output back into blocks. Used by T-E3 to assert labelling. */
export function parseRendered(rendered: string): { blocks: { name: string; authority: string; provenance: string }[]; strayContent: string[] } {
  const blocks: { name: string; authority: string; provenance: string }[] = [];
  const stray: string[] = [];
  let inBlock = false;
  for (const line of rendered.split('\n')) {
    if (line.startsWith('── ') && !line.startsWith('── truncated')) {
      const parts = line.replace(/^── /, '').split(' · ');
      blocks.push({ name: (parts[0] ?? '').trim(), authority: (parts[1] ?? '').trim(), provenance: (parts[2] ?? '').split(' ─')[0]!.trim() });
      inBlock = true;
      continue;
    }
    if (line.startsWith(RULE)) { inBlock = false; continue; }
    if (!inBlock && line.trim() !== '' && !line.startsWith('── truncated')) stray.push(line);
  }
  return { blocks, strayContent: stray };
}

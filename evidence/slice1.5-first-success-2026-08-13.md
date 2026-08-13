# Slice 1.5 — first successful real-model validation run

**Date:** 2026-08-13
**Command:**
```
node --experimental-strip-types src/harness.ts --repo .tmp/harness-scratch-repo --objective "Replace all oldFn() call sites in src/** with newFn()." --paths "src/**" --model claude-sonnet-5
```
**Raw event log:** [`slice1.5-first-success-2026-08-13-events.jsonl`](./slice1.5-first-success-2026-08-13-events.jsonl) — copied verbatim from the harness's temp dir (`aios-harness-5P1FT6`, disposable) before it could be lost.

## Result

```
attempt att_0001: completed
model calls: 7, tool calls: 6
cost: 0.0914
unit status: awaiting_approval
  gate artifact.schema_valid@1.0.0: pass
  gate deps.unchanged@1.0.0: pass
  gate locality.confined@1.0.0: pass
  gate api.schema_unchanged@1.0.0: pass
  gate build.typecheck@1.0.0: pass
  gate tests.affected_pass@1.0.0: pass
```

`artifact.verified` fired; `filesTouched: 1`. This is the first time in this line of investigation that a real Anthropic model completed the canonical `mechanical_change` objective end to end: read, write, verify, all six C0/C1 gates passing, reaching `awaiting_approval` — the same terminal state the scripted `FIXING_SCRIPT` reaches in the acceptance suite.

## What preceded it — three failed real runs, in order

| Run (`aios-harness-*`) | model calls | tool calls | cost | Result |
|---|---|---|---|---|
| `XXh05t` | 1 | 0 | $0.023 | Zero tool calls at all — the registered prompt existed but wasn't wired into the rendered context yet. |
| `9bAXJn` | 2 | 1 (read) | $0.0135 | Prompt wired in; model read the file, then produced nothing on turn 2. |
| `QZbz7X` | 2 | 1 (read) | $0.0132 | Same shape, after explicit CALL-format rules were added to the prompt. |
| (4 more manual runs) | 1–2 | 0–1 | $0.023–$0.0324 | Same shape, after the malformed-CALL executor fix (`executor.ts`) — proving the malformed-JSON theory, while a real and independently-worth-fixing bug, was not the dominant cause. |
| `5P1FT6` | **7** | **6** | **$0.0914** | **Success**, after switching `provider-anthropic.ts` to Anthropic's native `tools` schema. |

## Root cause and fix

Every failing run showed the same shape: the model correctly read the target file on turn 1, then produced a turn with **zero parsed actions — not even a malformed one**. That ruled out prompt clarity and malformed-JSON handling as the dominant cause (the executor fix would have caught and retried a malformed attempt, and never did). The actual defect: `provider-anthropic.ts` sent Claude a bare text prompt and relied on it freely choosing to reply in a hand-rolled `CALL tool scope {json}` text convention, with nothing constraining what it actually emitted.

**Fix:** the provider now sends Anthropic's native `tools` schema (structured, JSON-schema-validated tool calls — `fs_read`, `fs_write`, `shell_exec`, `git_commit`, plus explicit `done`/`refuse` tools) and deterministically translates the validated `tool_use` blocks into the existing `CALL <tool> <scope> {json}` text convention **in code**, never from the model's free text. `executor.ts`'s parser, `kernel.ts`, gates, and every scripted-provider test are unchanged — the fix is fully contained in `provider-anthropic.ts` (see `toCallText`).

## Verification

- `npm run typecheck`: PASS
- `npm run acceptance`: 95/95 PASS (89 prior + `T-N1`–`T-N6`, unit tests on `toCallText` with no live API calls)
- This one real run above: the first empirical confirmation with an actual model.

## What this does and does not prove

**Proves:** a real Claude model, given the current Slice 1.5 harness (unmodified Slice 01 Role/gates/policy, real repo, real tool broker, real gates), can complete the canonical `mechanical_change` migration objective end to end and pass every C0/C1 gate.

**Does not prove:** that this succeeds reliably across objectives, repo shapes, or repeated runs — this is a single successful run, not a statistical claim. `design/09-evaluation.md`'s point stands: an eval suite, not a single anecdote, is what would establish reliability.

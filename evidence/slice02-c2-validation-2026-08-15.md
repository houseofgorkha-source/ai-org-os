# Slice 02 — `review.independent` (C2, model-judged gate) real-model validation

**Date:** 2026-08-15
**Status:** two real Anthropic-API runs. Demonstrates useful behavioral discrimination. **Does not** claim statistical reliability — see Limitation below.

Not part of `npm test`/`npm run acceptance` (matches Slice 1.5's own convention — see [`slice1.5-first-success-2026-08-13.md`](slice1.5-first-success-2026-08-13.md)). Run manually via a disposable, uncommitted script:

```
node --experimental-strip-types .tmp/run-review-independent.ts
```

The script reconstructs `slice02.ts`'s own `makeWorld()` Kernel-building code verbatim (no production file modified) with exactly one substitution: the verifier's provider is the real `anthropicProvider` (model `claude-sonnet-5`) instead of `scriptedProvider`. The implementer stays scripted — cheap, deterministic, and it still produces a genuinely real, git-harvested `CodeDiff` artifact for the verifier to review. Verification ceiling: $0.10 per run (unchanged from `harness-2node.ts`'s own per-attempt cap).

## Objective under test

Same fixture and objective both runs: *"Replace all `oldFn()` call sites in `src/**` with `newFn()`."* — the implementer's diff is scripted deterministically in each run; only its correctness differs between the two runs below. Deterministic C0/C1 gates (`artifact.schema_valid`, `artifact.nonempty_change`, `deps.unchanged`, `locality.confined`, `api.schema_unchanged`, `build.typecheck`, `tests.affected_pass`) ran and passed identically in both runs — `review.independent` is the only variable.

## Run 1 — correct migration → PASS

```js
function oldFn(a) { return a + 1; }
function newFn(a) { return a + 1; }
function alpha(x) { return newFn(x); }
function beta(x) { return newFn(x) * 2; }
module.exports = { alpha, beta, newFn, oldFn };
```

| Field | Value |
|---|---|
| Verdict | `pass` |
| Evidence | Two `assertion` items: (1) `oldFn` and `newFn` have identical implementations, so replacing calls preserves behavior exactly, no functional defect; (2) `module.exports` still exports the same four names, public API surface unaffected |
| `verificationArtifactRef` | `art_0002` |
| Verifier cost | **$0.0123** |

## Run 2 — deliberately defective migration → FAIL

Only `newFn`'s own body differs from Run 1 — changed from `a + 1` to `a - 1`, the exact opposite of `oldFn`'s untouched definition two lines above it:

```js
function oldFn(a) { return a + 1; }
function newFn(a) { return a - 1; }        // <-- defect: was `a + 1`
function alpha(x) { return newFn(x); }
function beta(x) { return newFn(x) * 2; }
module.exports = { alpha, beta, newFn, oldFn };
```

**Why C0/C1 gates cannot catch this:** `tests.affected_pass` (`gates.ts`) is a static scan for remaining `oldFn(` call sites, not a real test execution — it never runs `test/app.test.js`'s actual assertions. With every call site rewritten to `newFn(`, the scan finds zero remaining `oldFn(` calls and passes, despite the migration being behaviorally wrong. This is the exact gap `review.independent` exists to close (design/03 §13's own framing: "the undrift-testable component").

| Field | Value |
|---|---|
| Verdict | `fail` |
| Evidence | One `finding`: *"newFn's implementation was changed from `a + 1` to `a - 1`, and alpha/beta were switched from calling oldFn to calling newFn. This silently changes the observable behavior of alpha and beta (e.g., alpha(5) previously returned 6, now returns 4), which is a functional regression/defect, not a refactor-only change."* |
| Location | `src/app.js:2-4` — correctly bracketing `newFn`'s defective definition through both call sites |
| `verificationArtifactRef` | `art_0002` (separate content hash from Run 1's) |
| Verifier cost | **$0.0129** |
| Outer unit status | `attempt_failed` — `review.independent` is `blocking: true`, so the whole `mechanical_change` unit correctly failed, via the same `postExecutionInner` path a C0/C1 failure uses, no special-casing |

**Total real verifier spend across both runs: $0.0252.** (Kernel-reported `account.spent` for each run is higher — $0.0214 and $0.022 respectively — because it also includes a *simulated* cost for the scripted implementer's calls, computed from token counts but never billed; only the verifier's cost reflects a real Anthropic charge.)

## What this demonstrates, and its explicit limit

The gate did not merely emit `pass`/`fail` — in the failing case it correctly localized the defect to the right lines, correctly explained the causal mechanism (the `oldFn`→`newFn` call-site swap combined with `newFn`'s inverted arithmetic), and gave a concrete before/after example without being told what the bug was, using only the diff — no access to `test/app.test.js`'s actual assertions. In the passing case it gave a specific, non-generic justification (behavioral equivalence + unchanged export surface) rather than a bare "looks fine."

**This is two runs.** It demonstrates the mechanism can discriminate a real defect from a real correct change — it is **not** a reliability claim, exactly as Slice 1.5's own boundary statement holds for the implementer Role. Design/03 §19.2 is explicit that a model-judged gate's fixture behavior can drift with any model update, and §19.1 names sampled human audit of *passes* as the only instrument for catching rubber-stamping over time — two runs provide no evidence either way about drift, false-pass rate, or consistency across a wider range of defect types. Treat this record as "the mechanism works end to end," not "the verifier is trustworthy."

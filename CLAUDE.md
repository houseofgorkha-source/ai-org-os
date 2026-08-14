# CLAUDE.md — AI-Org OS

Operating contract for Claude Code sessions in this repository. Read this first, then verify against the repository. **This file is instructions, not architecture.**

---

## 1. Project identity

**AI-Org OS** is a work-governance runtime for AI-executed software engineering. Its primitive is the **WorkUnit** — a typed contract with acceptance criteria — not the agent. Agents are a strategy for filling one step of a verified pipeline.

**Current purpose:** prove the architecture works by building it in vertical slices, smallest first.

**Current phase:** architecture complete and applied; **Slice 01 implemented and passing**; Slice 1.5 (real-model validation) empirically proven once; **Phase 1 Foundation is COMPLETE and FROZEN at commit `381f969`** — six bounded increments (dependency scheduling, plan-level status aggregation, pre-dispatch approval enforcement, escalation lifecycle records, attempt retry/exhaustion/escalation, unit rejection/cancellation), each closing a specific "declared in types/design but never wired" gap in `kernel.ts` (previously referred to as "Slice 2" — same body of work). See §3/§3a.

**Since the freeze, real Phase 2 work has landed** — plan-level cancellation/cascade, artifact-input content-hash pinning, an empty-diff acceptance gate, an instance-spend accounting fix, model-response forensic evidence, a new-file prompting fix, and a real-model 2-node integration harness (`harness-2node.ts`) that has now completed a full real Anthropic-API run end to end. This is not a reopening of Phase 1 — it's additional, individually-scoped increments on top of it, each with its own commit and tests. See §3b.

**Separately, Slice 02 is now implemented and real-model validated: the model-judged (C2) verification gate, `review.independent`.** This is the design's own next vertical slice (`design/SLICE-01-proposal.md` §0: "everything judgemental is deferred to slice 2"), not another Phase 2 infrastructure increment — see §3c. Two real Anthropic-API runs (a correct migration → `pass`, a deliberately defective one → `fail` with correctly-localized evidence) demonstrate the mechanism discriminates real defects; this is not a reliability claim from two runs.

**Do not implement further Phase 2 work, and do not extend Slice 02 further, unless explicitly instructed** — see §11 for current status (no specific next slice is currently known/audited), and §12.11 for the prohibition itself. Phase 1 being "frozen" means: treat it as a stable base to build on, not as unfinished work to keep extending opportunistically. The same discipline applies to Phase 2 increments already landed: each closed a specific, explicitly-instructed gap — it is not an invitation to keep extending Phase 2 opportunistically either.

---

## 2. Source-of-truth hierarchy

Listed most authoritative first *for its own domain*. When they disagree, the disagreement is a finding — report it, do not silently pick one.

| Source | Is truth for | Notes |
|---|---|---|
| `src/`, `tests/`, `package.json`, `tsconfig.json` | **Implementation** — what exists and behaves | The repo is the only evidence of implementation status |
| `tests/` (170 tests: 80 from the Slice 01 checklist, 9 executor/context regressions from the real-model investigation, 6 Slice 1.5 provider-translation tests, 26 Phase 1 Foundation kernel-lifecycle tests, 31 Phase 2 tests — plan-cancellation cascade, lifecycle hardening, input-hash pinning, the empty-diff gate, accounting reconciliation, response-shape forensics, and the new-file prompting fix (§3b), 18 Slice 02 tests — the C2 gate's pass/fail/indeterminate contract plus six lifecycle-fidelity regressions from a strict implementation audit (§3c)) | **Executable behaviour** | A test asserts a contract. Changing a test changes the contract |
| `design/01`–`design/09`, `APPENDIX-A` | **Architecture** | Design notes reflect all applied amendments |
| `design/AMENDMENTS-pending.md` | **Which architectural decisions are applied vs deferred** | Authoritative record; 34 applied, 4 accepted-deferred, 0 outstanding |
| `design/AMENDMENTS-E-architecture-close.md` | Full text of amendments E1–E4 (applied) | |
| `design/SLICE-01-acceptance-checklist.md` | **The implementation contract for Slice 01** | Scope is fixed by this file |
| `CLAUDE.md` (this file) | **How to work here** | Never a substitute for the above |

Design notes are large. **Reference them by section; do not paraphrase them into code comments or into this file.**

---

## 3. Current state (verified 2026-08-14)

**This IS now a git repository**, established during Slice 1.5/2 work. `origin` → `https://github.com/houseofgorkha-source/ai-org-os`, branch `master`. `rental-intel/` remains a separate, unrelated git repository. `.gitignore` covers `node_modules/`, `.tmp/`, `.env*`, `.claude/settings.local.json`, OS cruft. §9 and §12 below are updated to match — do not treat their old "not a git repository" framing as current.

### Architecture — complete
Design Notes 01–09 plus `APPENDIX-A-instrumentation.md`, `04a-memory-boundary.md`, `RECONCILIATION-01.md`, and both amendment ledgers. Amendment pass executed: **34 applied, 4 accepted-deferred, 0 outstanding.**

### Slice 01 — implemented, all tests passing
```
typecheck: PASS       170 tests, 170 pass, 0 fail   (80 from the checklist; 90 added since — see below, §3a, §3b, §3c)
```

### Source tree — `src/`, 20 modules, zero runtime dependencies
```
types.ts             core types (T-I1/T-F7 are TYPE-LEVEL assertions here; ModelResponseShape, §3b)
util.ts              canonical JSON, hashing, signing, kernel clock, globs
events.ts            append-only JSONL event log + causation chains
registry.ts          tool/gate/profile/role/recipe registries, signing, fixtures
predicate.ts         Note 08 language: 3-valued eval + coverage analysis
context.ts           Context Compiler + rendering contract + MemoryStore
resolve.ts           ResolvedExecutionSpec, composition, TierBindingResolver seam
validate.ts          deterministic pre-dispatch validation (C1–C12)
broker.ts            ToolBroker (denial path), ModelBroker (metering), tokens
executor.ts          agent loop + scriptedProvider/failingProvider; classifies
                        each turn's parse outcome as a ModelResponseShape (§3b)
harvest.ts           freeze, kernel-side diff, scope surfacing, artifact dedupe
gates.ts             8 gate implementations (+ artifact.nonempty_change, §3b),
                        ordering, quorum, short-circuit
kernel.ts            state machine, leases, admission, budget, recovery sweeps,
                        dependency graph + blocked propagation, plan-status
                        aggregation, C12 approval enforcement, escalation
                        records, attempt retry/exhaustion/escalation (Slice 2),
                        plan cancellation cascade, artifact-input content-hash
                        pinning, per-attempt spend reconciliation (§3b)
replay.ts            modes 1 (audit) and 2 (context)
instrument.ts        Appendix A measures + DisagreementSampler
slice01.ts           the slice's configuration and test world; implementer
                        prompt + target_files layer include new-file guidance (§3b)
slice02.ts           Slice 02's own registry/policy/recipe — the verifier
                        Role, review.independent gate, additive on top of
                        slice01.ts (never modifies it) — see §3c
provider-anthropic.ts  real Anthropic Messages API adapter — Slice 1.5, see below
harness.ts           Slice 1.5 single-real-attempt runner, NOT wired into npm test
harness-2node.ts     Phase 2 real 2-node integration harness, NOT wired into
                        npm test — see §3b
```
`tests/` — 5 files (`a-`, `bcd-`, `efghi-`, `jklm-`, `n-provider-anthropic`).

### Implemented
Registries with signing and mandatory negative fixtures · predicate language + coverage · deterministic validation · spec resolution with intersect/union/min · resolver seam · leases with epoch fencing · pessimistic budget reservation · spend-point metering, reconciled exactly once per attempt regardless of retry count (§3b) · capability tokens · tool broker with structured denial path and denial budget · model broker with fallback recording · executor loop, now emitting a structured (non-narrative) response-shape classification per model turn (§3b) · kernel-side harvest with out-of-scope surfacing · 8 gates with 4-valued verdicts, stage ordering, cheap-gate batching, expensive short-circuit, 3/3 quorum, including a deterministic empty-artifact rejection gate (§3b) and a real `model_judged` (C2) gate (§3c) · FailureRecord whitelist + retry · quorum approvals bound to content hash · event log + causation · replay modes 1 and 2 (now including a model_judged gate's own dispatch — §3c) · crash-recovery sweeps · Appendix A measures · plan-level cancellation with cascade to member units (§3b) · artifact-input content-hash pinning across `artifact`-kind dependency edges (§3b) · **(Slice 1.5, see below) a real Anthropic model provider, validated against a real API call — (§3b) a real 2-node plan run to full completion (`plan status: complete`) against the live Anthropic API — and (§3c) a real model-judged gate verdict, both `pass` and `fail`, against the live Anthropic API.**

### Not implemented (verified absent from `src/`)
No `MemoryProposal` · no `ArchitectureDecision` or constraint compilation · no `neighbourhood` context layer · no `RankSpec` · no `PrincipalAttentionBudget` · no `memory_policy` · no class promotion evaluation at runtime · no plan-level driver/scheduler (retry and multi-node dispatch remain caller-driven — see §3a). `WorkUnit`-level `reject()`/`cancel()` (Phase 1 Foundation item 6, `381f969`), plan-level `cancelPlan()`/cascade, and `WorkUnit.inputs[].contentHash` artifact-input pinning **are** now implemented (§3b) — all three were previously listed here as missing/not-yet-audited; none of them are any longer. **A `model_judged` gate now exists** (`review.independent@1.0.0`, Slice 02, §3c) — this section previously said "the enum value exists; no gate uses it"; that is no longer true. It exists only in Slice 02's own registry (`slice02.ts`), never in Slice 01's (`slice01.ts`'s `buildRegistry()` is untouched — `T-M4-scope` still asserts zero C2 gates there).

### §3a. Phase 1 Foundation — kernel lifecycle completion (COMPLETE AND FROZEN at `381f969`, verified 2026-08-14)

Not a new architecture, not a new slice *proposal* document — six bounded increments (previously tracked here as "Slice 2"; same work, this is the current name for it), each closing a specific "declared in `types.ts`/design, never wired in `kernel.ts`" gap, discovered by auditing the call graph rather than assuming a definition being present meant it was used. All on `master`, commits `1b3d860`…`381f969`. Each increment: `src/kernel.ts` (+ narrowly `src/types.ts` once) and its own tests only — no new Role, no C2 gate, no scheduler, no design-doc changes (all are implementations of already-specified behavior, not new decisions).

**This list is frozen.** Do not add a seventh increment here without explicit instruction — see §1 and §11.

1. **Dependency graph runtime** (`1b3d860`) — `materialise()` populates `WorkUnit.dependsOn` from authored `artifact`/`ordering` plan edges; `admit()` defers on unmet dependencies and transitions `validated → blocked` when an upstream dependency fails. `blocked` propagates transitively through chains (a fix landed one slice later, `59a712d`, after the plan-aggregation audit surfaced it — `blocked` was originally missing from the terminal-failure classification `admit()` uses).
2. **Plan-level status aggregation** (`59a712d`) — `approved → running → complete/partial` (design/06 §2.4), a kernel-owned projection keyed `plan.id@plan.version`, never mutating the input `TaskPlan`.
3. **Pre-dispatch approval enforcement** (`bafab45`) — `admit()` now actually calls the C12 validator (`validate.ts`'s `validateDispatchApprovals`, previously only exercised by tests directly).
4. **Escalation lifecycle records** (`ead459c`) — a real `Escalation` object (`id, unitId, klass, raisedAt, resolvedAt, resolution`) and `resolveEscalation()`, recording the escalation paths that already existed (`capability_denied`, `indeterminate`) rather than only emitting a bare event.
5. **Attempt retry/exhaustion/escalation** (`874c035`) — `admit()` now makes the `attempt_failed → ready | exhausted → escalated | escalated` decision (design/06 §2.1), using the pre-existing `canRetry()`/`noProgress()` (previously correct but never called by the kernel itself). **Deliberately preserved, not changed:** `attempt_failed` is never auto-promoted at failure time — `postExecution` still just sets it and stops; the decision fires only when `admit()` is next called on that unit. This is load-bearing (`T-F10`, `T-F13` assert `attempt_failed` persists through one failed attempt with no `admit()` call) and confirms retry is **caller-driven**, not kernel-automatic — nothing in `kernel.ts` launches a second attempt by itself, anywhere.
6. **Unit rejection and cancellation** (`381f969`) — `reject(unitId, artifactId)` (`awaiting_approval → rejected`, mirrors `accept()`'s hash-binding but consumes a `reject` decision) and `cancel(unitId, reason)` (`{validated, ready, blocked, attempt_failed, awaiting_approval} → cancelled`, deliberately excluding `running`/`verifying` — proven architecturally unreachable, not merely unhandled: `runAttempt()` is a single synchronous call with no yield point, so nothing can call `cancel()` while a unit is genuinely mid-attempt). `abandoned` (cut short, never evaluated) vs `rejected` (evaluated and failed) is preserved exactly per Note 02 §13 — `cancel()` only ever produces `abandoned` artifacts, `reject()` only ever produces `rejected` ones. Descendant-blocking and plan-aggregation-to-`partial` needed **zero new code** — both mechanisms already treated `cancelled`/`rejected` as terminal-failure statuses since increment 1/2, before anything could produce them; `T-D18`/`T-D19` prove this empirically, not by inspection.

**Evidence trail worth knowing about before touching this area again:** three multi-turn audits preceded implementation for the DAG, retry, and plan-cancellation-scoping work specifically, each surfacing a real behavioral gap between what the proposed plan assumed and what the call graph actually did (the `blocked`-propagation gap; the `attempt_failed`-timing constraint; and — for what was then the still-unimplemented plan-cancel cascade, now landed as §3b item 1 — `recomputePlanStatus`'s idempotency guard not yet accounting for `cancelled`, closed as part of that implementation). Re-derive from the repository, don't assume the shape of the *next* gap matches these.

### Slice 1.5 — real-model validation harness (verified 2026-08-13)

Not part of Slice 01's scope, not wired into `npm test`/`npm run acceptance`. Runs exactly one real `mechanical_change` WorkUnit — the same Role, gates, and instance policy as Slice 01, unmodified — against a real repo and a real Anthropic API call.

```
node --experimental-strip-types src/harness.ts --repo <git repo> --objective "<text>" [--paths "src/**"] [--model claude-sonnet-5] [--dry-run]
```

**First successful real run: 2026-08-13.** 7 model calls, 6 tool calls, $0.0914, all six gates pass, `awaiting_approval`. Full evidence, including the three failed runs that preceded it and the two root-cause fixes that resolved them, is preserved in [`evidence/slice1.5-first-success-2026-08-13.md`](evidence/slice1.5-first-success-2026-08-13.md) (raw event log alongside it — the harness's own temp dirs are disposable and do not survive).

**What made the first three real runs fail, and what fixed each:**
1. The registered prompt wasn't wired into the rendered context at all (`registry.getPrompt()` was defined but never called) — fixed by adding a `role_prompt` context layer (`slice01.ts`, `context.ts`).
2. Malformed/multi-line `CALL` syntax was silently discarded or silently executed with corrupted empty arguments — fixed in `executor.ts`'s `parseActions`, which now feeds a structured (count-only, non-narrative) diagnostic back into the loop, mirroring how capability denials already work.
3. The dominant cause: `provider-anthropic.ts` asked the model to freely hand-format an ad hoc `CALL tool scope {json}` text convention, with nothing constraining what it actually emitted — fixed by switching to Anthropic's native `tools` schema and deterministically translating the schema-validated `tool_use` blocks into that same text convention in code (`toCallText`), never from the model's free text.

**What this proves and does not:** a single successful real run proves the mechanism *can* work end to end. It is not a reliability claim — see `evidence/slice1.5-first-success-2026-08-13.md` for the explicit boundary.

### §3b. Phase 2 groundwork — landed since the Phase 1 freeze (verified 2026-08-14)

Individually-scoped increments, each with its own commit and tests, not a reopening of Phase 1. Items 1–3 predate this document's last update (their code existed, uncommitted, before the session that produced this update — that session's own work formally committed them). Items 4–8 were diagnosed and built during that session, driven end-to-end by real Anthropic-API runs of `harness-2node.ts` rather than by static audit alone.

1. **Plan cancellation cascade** (`b577a09`) — `Kernel.cancelPlan(planId, version, reason)`: `approved|running → cancelled` on the plan projection, then cascades `cancel()` to every member `WorkUnit` whose status is still cancellable, by iterating plan membership directly rather than walking dependency edges — closing the descendant question §11 used to leave open (a full-plan cascade reaches every member node directly regardless of edges; explicit descendant-walking was never needed for units inside the same plan). `recomputePlanStatus`'s idempotency guard now also treats `cancelled` as terminal, alongside `complete`/`partial` — closing the silent-overwrite gap §11 used to flag. Tests: `T-P1`–`T-P9`.
2. **Lifecycle consistency hardening** (`a426238`) — `materialise()` now refuses (throws) a new node under a plan whose kernel-tracked projection is already terminal (`complete`/`partial`/`cancelled`), checked against the kernel's own live projection, never a possibly-stale caller-supplied `plan` object. `accept()` gains an explicit `status !== 'awaiting_approval'` guard (ordered *after* the existing blocking-gates check, to preserve `T-J4`'s existing failure-reason contract) — closing a gap where a cancelled/rejected unit whose gates had already passed could still be accepted, since gate results are never cleared by `cancel()`/`reject()`.
3. **Artifact-input content-hash pinning** (`e1fed0e`, implementation already in `kernel.ts` via `2e3d02a`) — an `artifact`-kind dependency edge now pins its accepted predecessor's `artifactId`/`contentHash` into the dependent `WorkUnit.inputs`, the first time `admit()` observes the predecessor accepted (`materialise()` cannot do this — predecessors aren't run yet). `as` defaults to the predecessor's `planNodeId` (no authored binding name exists in the plan schema); `segments` defaults to `[]`. A pinned hash that no longer matches the stored artifact refuses admission (`input_hash_mismatch`) rather than trusting it. An `ordering`-kind edge pins nothing. Tests: `T-D23`–`T-D28`.
4. **Empty-diff acceptance gate** (`3aed99a`) — a real 2-node harness run (`aios-2node-Lx5KMr`/`PuYjDz`) surfaced that a `mechanical_change` attempt producing a genuinely empty diff (`filesTouched: 0`) passed every existing gate vacuously — none of them checked that *any* change had actually been made. New deterministic C0 gate `artifact.nonempty_change@1.0.0`, bound into the `mechanical_change` profile, fails when `files_touched` is empty. Test: `T-H9`.
5. **Instance-spend accounting fix** (`a24ee3f` then `3f4e06b`) — two distinct bugs, found in sequence. First, `releaseReservation()` assigned `account.spent = actual` instead of accumulating (`+=`), so each unit's terminal reconciliation erased every prior unit's recorded spend (`a24ee3f`, `T-L6`). Second — found only once a real harness run exercised a genuine retry — `actual` was computed by summing ledger spend over *all* of a unit's attempts on *every* release call, so a unit that failed once and retried had its first attempt's spend folded into `account.spent` twice (`3f4e06b`). Fixed by tracking `reconciledAttempts` (a `Set<AttemptId>`) per unit so each attempt contributes exactly once, regardless of how many times release fires. Test: `T-L7`.
6. **Model-response forensic evidence** (`2e3d02a`) — a real run (`aios-2node-Lx5KMr`) terminated `completed` with zero tool calls, and there was no way to tell, after the fact, whether the model had said `DONE`, returned inert prose, or attempted malformed `CALL` syntax — `executor.ts`'s `narrative` capturing this is deliberately private and in-memory only, and dies with the process. New `ModelResponseShape` (`types.ts`) — `'tool_call' | 'done' | 'refused' | 'no_action' | 'malformed'` — computed per turn in `executor.ts` from the same `parseActions()` result already used for control flow (no raw model text ever leaves the function), and attached to the `model.served` event payload keyed by that call's `seq`. Tests: `T-F14`–`T-F17`.
7. **New-file prompting fix** (`b563263`) — with (6) in place, a real run proved the model was calling `done` on turn 1 with zero tool calls for a *create-a-new-file* objective specifically, never for an edit-an-existing-file objective. Root cause, confirmed by rendering the actual production context offline against the actual failed run's workspace (no API call needed): `target_files` (`slice01.ts`) can only ever list files that already exist, so a new-file objective's target never appears in context, and the role prompt's only worked `fs.write` example (and its only DONE guard, "reading is never sufficient on its own") both talk about *editing*, never creating. Fix, additive only: a new worked example for creating a file (`slice01.ts`'s registered prompt), an explicit rule that planning/describing a change is not the same as making it, and a static footer on `target_files` telling the model an absent file still needs to be created via `fs.write`. Tests: `T-E8`–`T-E10`.
8. **`harness-2node.ts`** (`753f265`) — a real, 2-node (`ordering`-dependent) `mechanical_change` plan against a real Anthropic API call, following the same committed-but-acceptance-excluded pattern as `harness.ts`. Hard-capped at $0.30 total ($0.10 per attempt × up to 3 attempts: n1 once, n2 up to twice via a bounded, `admit()`-gated caller-driven retry that correctly reuses the lease acquired before attempt 1, never re-acquiring — `kernel.ts` `acquireLease()`'s compare-and-set correctly refuses a redundant second acquisition, proven by `T-I7b`). **First full real success: 2026-08-14**, `aios-2node-Q9mZbP` — n1 accepted (7 model calls, 5 tool calls, $0.0865), n2 accepted on its *first* attempt with no retry needed (5 model calls, 4 tool calls, $0.0536), `plan status: complete`, `account.spent: $0.1401`. Before item 7's fix, n2 failed this way on 4 of 5 real runs.

### §3c. Slice 02 — model-judged (C2) verification gate (verified 2026-08-15, commit `fba0ed6`)

**This is the design's own next vertical slice, not a Phase 2 infrastructure increment.** `design/SLICE-01-proposal.md` §0: *"So slice 1 is: one Role, a human-authored plan, C0/C1 gates only, one human merge approval... Everything judgemental is deferred to slice 2."* Its exclusion table (line 247): *"Model verifier / any C2 criterion — introduce only once C0/C1 gates are trusted."* Built now that Slice 01, Phase 1 Foundation, and §3b's real 2-node run have established exactly that. **Naming note:** this is unrelated to the historical "Slice 2" synonym for Phase 1 Foundation used in §1/§3a — one repository, two unrelated prior uses of the same informal name; §3a's is frozen history, this is the design document's own term.

**Contract** (`design/03-gate-registry-and-verification.md` §13): a `model_judged` gate executes as a real WorkUnit, is subject to every Note 02 rule (validation, budget, capability token, context manifest, Attempt record, replayability — "not a privileged path"), the verifier Role has no write capability, `indeterminate` routes to a human, and — critically, §19.2 — **a model-judged gate cannot be fixture-tested** ("a fixture the verifier rejects this week may pass next week after a model update"); `registry.ts`'s `registerGate()` now exempts `criterionClass: 'C2'` from the `must_fail`/`must_pass` requirement accordingly.

**Implementation** (`fba0ed6`): `kernel.ts`'s `runAttempt()`/`postExecutionInner()` each gain exactly one branch point — `runVerifier()` (`executor.ts`, new) instead of `runExecutor()`, and a `VerificationReport` artifact instead of a harvested `CodeDiff` — because a verifier's *output shape* differs, not because it needs a separate lifecycle. Everything else (lease/epoch, budget reservation/reconciliation, capability token minting, context manifest persistence, Attempt records, events) is the same, unmodified machinery every WorkUnit already goes through. The artifact under review is redacted to the gate's declared `requiresSegments` ∩ `visibility:'public'` at the exact kernel/context boundary, before context compilation can reach it — `implementation_notes`/`reasoning_trace`/`self_assessment` structurally cannot reach a verifier's context. Slice 02 has its own registry/policy module (`slice02.ts`), attaching `review.independent@1.0.0` to `mechanical_change` via the existing `POLICY.classPolicy.extraGates` mechanism — `slice01.ts`'s own `buildRegistry()`/`GATE_PROFILE` are never touched; `T-M4-scope` (Slice 01's own C2-absence assertion) still passes unmodified.

**An early draft of this dispatch took five lifecycle shortcuts, found by a strict audit and then fixed** (all five now have direct regression tests, `T-O13`–`T-O18`): the verifier bypassed `materialise()`/`admit()`/lease entirely; produced no real `Attempt` record; minted no capability token; computed a context manifest and discarded it; and had no structural enforcement (only convention) preventing private/restricted artifact segments from reaching it. The fix routes the verifier through the exact same `materialise → admit → acquireLease → runAttempt` pipeline any WorkUnit uses — see the commit message and `kernel.ts`'s `runModelJudgedGate()` doc comment for the full account. This is *why* the contract's "not a privileged path" language is enforced structurally now, not just asserted in a comment.

**Real-model validation: two runs, 2026-08-15.** A correct migration → `review.independent` returns `pass` with specific behavioral-equivalence evidence ($0.0123). A deliberately defective migration (`newFn` changed from `a + 1` to `a - 1` — undetectable by any C0/C1 gate, since `tests.affected_pass` only scans for remaining `oldFn(` call sites, never runs the real test file) → `review.independent` returns `fail`, correctly localizing the defect to `src/app.js:2-4` and correctly explaining the mechanism, with a concrete before/after example, using only the diff ($0.0129). Full record, including the exact evidence text and the reasoning for why C0/C1 cannot catch this defect class: [`evidence/slice02-c2-validation-2026-08-15.md`](evidence/slice02-c2-validation-2026-08-15.md). Run via a disposable, uncommitted `.tmp/run-review-independent.ts` (gitignored — `.tmp/` is disposable, see §8).

**What this proves and does not:** the mechanism discriminates a real defect from a real correct change, end to end, against a live model. It is not a reliability claim — two runs say nothing about drift, false-pass rate, or performance across a wider range of defect shapes. Design/03 §19.1 names sampled human audit of *passes* as the only instrument for catching rubber-stamping over time; that remains a permanently open item (§6).

---

## 4. Architectural invariants

Do not violate these. Each is enforced by code **and** by a test. Read the referenced section before changing anything near them.

| Invariant | Where | Test |
|---|---|---|
| Executor is untrusted and **least** privileged; holds **no credentials of any kind** | Note 07 §17 | T-F5, T-F6 |
| **Kernel-side harvest** — the artifact is derived from the workspace, never reported by the executor | Note 07 §3 | T-G3, T-K6 |
| Executor cannot manufacture artifacts, verdicts, status, or cost | Note 07 §12 | T-F7 (type-level) |
| Out-of-scope changes are **surfaced and flagged, never silently filtered** | Note 07 §3 | T-G4 |
| A denial is **data, not an error**; refusal names granted scopes; `capability_denied` escalates and never retries | Note 07 §7 | T-F3, T-F4 |
| All model calls pass through the Model Broker, which meters at the call boundary | Note 07 §8 | T-F5, T-L1 |
| Deterministic validation before dispatch; **a rejection that costs a token is a bug** | Note 02 §9 | T-C-global |
| Capability composition **narrows only** (`intersect_only`) | Note 01 §6–7 | T-A5 |
| Gate composition **strengthens only** (`union_only`, monotonic) | Note 01 §9 | T-A6 |
| Gate verdicts are four-valued; `error` ≠ `fail` and consumes no attempt; `indeterminate` escalates | Note 03 §4 | T-H2, T-H3 |
| Every gate carries a **`must_fail` fixture** — a gate that never rejects is a decoration | Note 03 §8 | T-A1, T-A3, T-A3b |
| `Gate.requires_context` is a **closed enumeration**; no gate may reach memory | Note 03 §2 (D3) | T-A4 |
| Only a **human** may create an `Approval`; it binds a content hash; any change voids **every** signature | Note 02 §12 (C3) | T-J2, T-J2b, T-J3 |
| Budget decrements **at the moment of spend**, never at success; failed attempts' cost is retained | Note 06 §6 | T-L1, T-L2 |
| Reservation is **pessimistic**; `fail_closed` is the only exhaustion policy | Note 06 §7 | T-L3, T-L5 |
| Every state transition is an event; all queryable state is a projection | Note 06 §11 | T-K1 |
| Replay mode 1 always works; **mode 2 recompiles from PINNED SOURCES, not the mutated workspace** | Note 02 §14 | T-K4, T-K5 |
| Exactly one executor may harvest per unit-epoch; superseded workspaces are disposed unharvested | Note 06 §3–4 | T-K8 |
| `FailureRecord` is a **whitelist**: no field can carry the failed attempt's narrative | Note 02 §11 | T-I1, T-I2 |
| A retry creates an `Attempt` and never mutates the `WorkUnit` contract | Note 02 §1 | T-I5 |
| **Memory informs; it never constrains.** The Context Compiler is its sole consumer | Note 05 §7 | T-A4, T-E2 |
| Only the kernel reads wall-clock time for decisions | Note 06 §13 | — |
| The kernel contains **no model call** | Note 06 §1 | — |

**Note 07 §3 and Note 06 §4 are load-bearing for each other.** If an executor could ever submit its own artifact, split-brain converts from a cost problem into a correctness problem, silently. Never change one without the other in view.

---

## 5. Current scope — what Slice 01 proved

**It proved the machine.** One Role (`implementer@1.0.0`), human-authored plan, four registered tools, six C0/C1 gates plus a C3 merge approval, three human approval points. A deliberate gate failure and a deliberate capability denial are exercised, then a successful retry to acceptance.

**It proved nothing about the work.** Every model call was scripted. Untested: whether a real model can complete the task, whether the compiled context contains what it needs, whether cost per accepted change is economic, whether human-authored criteria are good enough.

**One test is weaker than it looks.** `T-F3` asserts the denial path produces adaptation — but the scripted model adapts *because it was scripted to*. Note 07 §7's claim that a legible refusal produces adaptation rather than a loop is an empirical claim about real model behaviour and is currently unverified.

**Deliberately not implemented in Slice 01's own checklist scope** (per `SLICE-01-acceptance-checklist.md` §O, still true of the 80 checklist tests themselves): architect Role and constraint compilation · any C2 criterion or model verifier · planner Role · multi-node DAG and artifact edges · class promotion rules · Memory beyond the zero-record case · non-trivial instance policy composition · escalation flow and attention policy · quorum > 1 in practice · `approve_with_conditions` · budget-increase approval · fleet layer · `RankSpec` · scheduling priority · `constraint_cases` in the eval suite. **Three of these are now implemented, but never inside Slice 01 itself:** multi-node DAG/dependency edges and escalation flow, at the kernel level as Phase 1 Foundation (§3a); and any C2 criterion/model verifier, as the separate Slice 02 (§3c), in its own registry (`slice02.ts`), never in Slice 01's. Slice 01's own plan/tests remain single-node, admit no verifier Role, and register no C2 gate — none of this is a change to Slice 01's own contract, `T-M4-scope` included.

---

## 6. Deferred work

**These are deferred by decision. Do not treat them as a backlog to be cleared.**

Deferred amendments (ledger status `accepted (deferred)`, all `defer-to-instance-2`):
- **C1** principal-aggregated attention budgets
- **C2b** gate-registration quorum (a `FloorPolicy` value, not a hardcoded 2)
- **C4** the fleet layer itself — *the resolver seam is built; nothing above it is*
- **D7** `memory_policy` on `InstancePolicy`

Deferred by decision, never amendments: `RankSpec` / retrieval ranking · planner decomposition strategy · scheduling priority among admissible units · fleet binding-table implementation.

Permanently open, needing data rather than design (`AMENDMENTS-pending.md`, Open items):
- Criteria-quality gate — the ceiling on the whole system; no solution proposed
- Code-comment leak through `public` diff segments — unfixable by schema
- Model-judged gate drift / rubber-stamping — sampled human audit of *passes* is the only instrument
- `SelectorExpr` / `PredicateExpr` grammar — the boolean half is Note 08; ranking and `neighbourhood` static analysis remain open

---

## 7. Development rules

1. **Inspect before editing.** Read the module and its tests. Assume the current design is deliberate until the repository shows otherwise.
2. **Preserve the architecture.** If a change requires violating §4, stop and raise it.
3. **Do not create a new abstraction when an existing one owns the behaviour.** Registries own registration; the kernel owns state; brokers own enforcement; gates own verdicts.
4. **Never modify a test merely to make it pass.** A failing test is a claim about the contract. Either the code is wrong, or the contract changed — and a contract change needs a design/ledger record first.
5. **Every architectural change updates the appropriate record** — the design note *and* a ledger entry. Code that contradicts `design/` without a ledger entry is a defect.
6. **Run `npm run acceptance` after changes.** Typecheck is not optional: `T-I1` and `T-F7` are type-level assertions.
7. **Keep changes small and auditable.** Prefer one behaviour per change.
8. **Never silently broaden scope.** If the work implies more than was asked, say so and stop at the boundary.

---

## 8. Testing

```bash
npm run typecheck
```
```bash
npm run acceptance
```
```bash
npm test
```

Focused runs:
```bash
node --test --experimental-strip-types "tests/jklm-approval-replay-budget.test.ts"
```

- `acceptance` = typecheck + full suite. **This is the gate.**
- Test files run as **parallel processes**; fixture worlds are pid-scoped under `.tmp/`. Tests passing individually but failing together usually means a shared-path collision.
- `.tmp/` is disposable. `rm -rf .tmp` before a clean run.
- Type-level assertions live in `src/types.ts` — `FailureRecord` must never gain a narrative field, `ExecutorResult` must never gain artifact/verdict/status/cost.

---

## 9. Repository safety

- **AI-Org OS lives in `C:\Projects\ai-org-os`.** It **is** a git repository (`origin` → `github.com/houseofgorkha-source/ai-org-os`, branch `master`) — see §3.
- **RentalIntel lives in `C:\Projects\rental-intel` and IS a separate, unrelated git repository** (`rental-intel`).
- **Never move AI-Org OS code into RentalIntel, or the reverse.**
- **Never modify RentalIntel unless explicitly instructed.**
- AI-Org OS has **zero runtime dependencies**; devDependencies are `typescript` and `@types/node` only. It shares nothing with RentalIntel. **Do not assume a shared skill, tool, or dependency — verify and name it before relying on it.**

---

## 10. Session start protocol

1. Read this file.
2. Check repository state: `git status`, `git log --oneline -5` — this is a real git repository now (§3, §9). A dirty or ahead-of-origin working tree from a prior session is a finding, not an error.
3. Read the source and tests for the area in question. **Do not work from memory of prior sessions.**
4. Identify the current task and check §3 for what is already done — **do not redo completed work**.
5. **State the intended change before making a large one**, and name which invariant (§4) it touches, if any.
6. Finish with `npm run acceptance` and report results by test ID.

---

## 11. Current next step

**Phase 1 Foundation is frozen (§1, §3a). Phase 2 groundwork (§3b) has since landed — plan cancellation/cascade, input-hash pinning, the empty-diff gate, spend-accounting reconciliation, response-shape forensics, and the new-file prompting fix. Do not implement further Phase 2 work without explicit instruction in the session.** This section previously named plan-level cancellation as the audited-but-unimplemented next candidate — it is now implemented (§3b item 1) and that framing is stale; it is left here, corrected, so a future session doesn't rediscover it as "still open."

**Slice 02 (§3c, the design's own next vertical slice) is now implemented and real-model validated.** No specific next architectural slice is currently authorized or committed to in this document. If asked to find one, the working pattern established across Phase 1 Foundation (§3a), Phase 2 (§3b), and Slice 02 (§3c) still applies: grep for a status/field/type declared but never constructed or called, verify the call graph (not just the definition) before assuming a proposed fix's shape is correct, wire it into the smallest existing entry point rather than adding new machinery, and re-run the full suite before *and* after to catch load-bearing assumptions the audit alone might miss. Several of §3b's increments (5, 6, 7 especially) and §3c's own five-shortcut fix were found only because a *real* Anthropic-API run, or a strict audit of one, surfaced a gap no offline read had — real-run evidence has repeatedly outperformed static audit alone for finding the next gap; weight it accordingly.

---

## 12. Prohibitions

Without explicit instruction, do **not**:

1. Redesign the architecture, or reopen a decision recorded as applied in the ledger.
2. Create new design notes. The architecture pass is closed; changes are **amendments**.
3. Implement deferred multi-instance or fleet features (C1, C2b, C4, D7). The resolver seam is the only part that exists.
4. Add organisation Roles — architect, planner, verifier — for demonstration or completeness, **into Slice 01**. Slice 01 has exactly one Role, and its instance policy admits only that one. (A `verifier` Role now exists — Slice 02, §3c — but only in its own separate registry, `slice02.ts`; this was explicitly authorized in-session, and does not touch Slice 01's.)
5. Introduce a C2 / model-judged gate, or an escalation path, into Slice 01. `T-M4-scope` asserts their absence mechanically. (A C2 gate now exists — `review.independent`, Slice 02, §3c — again, explicitly authorized, and only in Slice 02's own registry; Slice 01's remains empty, `T-M4-scope` unmodified and still passing.)
6. Replace a deterministic mechanism with LLM reasoning. The kernel contains no model call, and validation, resolution, harvest, and gate routing must stay deterministic.
7. Weaken a security boundary: executor credentials, network egress, capability scoping, the closed gate-context enumeration, or private-segment reachability.
8. Modify `rental-intel/`.
9. Commit, push, force-push, or rewrite history without being asked — even though this is now an established git repository (§3, §9), each of those remains an explicit-instruction-only action.
10. Edit a test to make a failing build green.
11. Implement further Phase 2 work without explicit instruction in the session — see §3b for what has already landed (plan cancellation/cascade, input-hash pinning, the empty-diff gate, spend-accounting reconciliation, response-shape forensics, the new-file prompting fix) and §11 for current status. Landed Phase 2 increments are not an invitation to keep extending Phase 2 opportunistically, any more than Phase 1 Foundation was.

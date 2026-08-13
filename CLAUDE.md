# CLAUDE.md — AI-Org OS

Operating contract for Claude Code sessions in this repository. Read this first, then verify against the repository. **This file is instructions, not architecture.**

---

## 1. Project identity

**AI-Org OS** is a work-governance runtime for AI-executed software engineering. Its primitive is the **WorkUnit** — a typed contract with acceptance criteria — not the agent. Agents are a strategy for filling one step of a verified pipeline.

**Current purpose:** prove the architecture works by building it in vertical slices, smallest first.

**Current phase:** architecture complete and applied; **Slice 01 implemented and passing**; Slice 1.5 (real-model validation) empirically proven once; **Phase 1 Foundation is COMPLETE and FROZEN at commit `381f969`** — six bounded increments (dependency scheduling, plan-level status aggregation, pre-dispatch approval enforcement, escalation lifecycle records, attempt retry/exhaustion/escalation, unit rejection/cancellation), each closing a specific "declared in types/design but never wired" gap in `kernel.ts` (previously referred to as "Slice 2" — same body of work). See §3/§3a.

**Do not implement Phase 2 work unless explicitly instructed** — see §11 for what's already known and audited, and §12.11 for the prohibition itself. Phase 1 being "frozen" means: treat it as a stable base to build on, not as unfinished work to keep extending opportunistically.

---

## 2. Source-of-truth hierarchy

Listed most authoritative first *for its own domain*. When they disagree, the disagreement is a finding — report it, do not silently pick one.

| Source | Is truth for | Notes |
|---|---|---|
| `src/`, `tests/`, `package.json`, `tsconfig.json` | **Implementation** — what exists and behaves | The repo is the only evidence of implementation status |
| `tests/` (121 tests: 80 from the Slice 01 checklist, 9 executor/context regressions from the real-model investigation, 6 Slice 1.5 provider-translation tests, 26 Phase 1 Foundation kernel-lifecycle tests) | **Executable behaviour** | A test asserts a contract. Changing a test changes the contract |
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
typecheck: PASS       121 tests, 121 pass, 0 fail   (80 from the checklist; 41 added since — see below and §3a)
```

### Source tree — `src/`, 18 modules, zero runtime dependencies
```
types.ts             core types (T-I1/T-F7 are TYPE-LEVEL assertions here)
util.ts              canonical JSON, hashing, signing, kernel clock, globs
events.ts            append-only JSONL event log + causation chains
registry.ts          tool/gate/profile/role/recipe registries, signing, fixtures
predicate.ts         Note 08 language: 3-valued eval + coverage analysis
context.ts           Context Compiler + rendering contract + MemoryStore
resolve.ts           ResolvedExecutionSpec, composition, TierBindingResolver seam
validate.ts          deterministic pre-dispatch validation (C1–C12)
broker.ts            ToolBroker (denial path), ModelBroker (metering), tokens
executor.ts          agent loop + scriptedProvider/failingProvider
harvest.ts           freeze, kernel-side diff, scope surfacing, artifact dedupe
gates.ts             7 gate implementations, ordering, quorum, short-circuit
kernel.ts            state machine, leases, admission, budget, recovery sweeps,
                        dependency graph + blocked propagation, plan-status
                        aggregation, C12 approval enforcement, escalation
                        records, attempt retry/exhaustion/escalation (Slice 2)
replay.ts            modes 1 (audit) and 2 (context)
instrument.ts        Appendix A measures + DisagreementSampler
slice01.ts           the slice's configuration and test world
provider-anthropic.ts  real Anthropic Messages API adapter — Slice 1.5, see below
harness.ts           Slice 1.5 single-real-attempt runner, NOT wired into npm test
```
`tests/` — 5 files (`a-`, `bcd-`, `efghi-`, `jklm-`, `n-provider-anthropic`).

### Implemented
Registries with signing and mandatory negative fixtures · predicate language + coverage · deterministic validation · spec resolution with intersect/union/min · resolver seam · leases with epoch fencing · pessimistic budget reservation · spend-point metering · capability tokens · tool broker with structured denial path and denial budget · model broker with fallback recording · executor loop · kernel-side harvest with out-of-scope surfacing · 7 gates with 4-valued verdicts, stage ordering, cheap-gate batching, expensive short-circuit, 3/3 quorum · FailureRecord whitelist + retry · quorum approvals bound to content hash · event log + causation · replay modes 1 and 2 · crash-recovery sweeps · Appendix A measures · **(Slice 1.5, see below) a real Anthropic model provider, validated against a real API call.**

### Not implemented (verified absent from `src/`)
No `MemoryProposal` · no `ArchitectureDecision` or constraint compilation · no `model_judged` gate (the enum value exists; no gate uses it) · no `neighbourhood` context layer · no `RankSpec` · no `PrincipalAttentionBudget` · no `memory_policy` · no class promotion evaluation at runtime · no `WorkUnit.inputs[].contentHash` artifact-input pinning (`inputs: []` always) · no plan-level driver/scheduler (retry and multi-node dispatch remain caller-driven — see §3a) · **no plan-level cancellation/cascade** (`TaskPlan.status` is typed `cancelled` but the kernel never assigns it; `cancelPlan()` does not exist — audited, not yet implemented, see §11). `WorkUnit`-level `reject()`/`cancel()` **are** now implemented (Phase 1 Foundation item 6, `381f969`) — this was previously listed here as missing; it no longer is. (A real model provider *is* implemented — Slice 1.5 — and multi-node dependency scheduling, plan aggregation, escalation records, and unit rejection/cancellation *are* now implemented — Phase 1 Foundation, §3a — but none of this is part of Slice 01's own 80-test checklist scope.)

### §3a. Phase 1 Foundation — kernel lifecycle completion (COMPLETE AND FROZEN at `381f969`, verified 2026-08-14)

Not a new architecture, not a new slice *proposal* document — six bounded increments (previously tracked here as "Slice 2"; same work, this is the current name for it), each closing a specific "declared in `types.ts`/design, never wired in `kernel.ts`" gap, discovered by auditing the call graph rather than assuming a definition being present meant it was used. All on `master`, commits `1b3d860`…`381f969`. Each increment: `src/kernel.ts` (+ narrowly `src/types.ts` once) and its own tests only — no new Role, no C2 gate, no scheduler, no design-doc changes (all are implementations of already-specified behavior, not new decisions).

**This list is frozen.** Do not add a seventh increment here without explicit instruction — see §1 and §11.

1. **Dependency graph runtime** (`1b3d860`) — `materialise()` populates `WorkUnit.dependsOn` from authored `artifact`/`ordering` plan edges; `admit()` defers on unmet dependencies and transitions `validated → blocked` when an upstream dependency fails. `blocked` propagates transitively through chains (a fix landed one slice later, `59a712d`, after the plan-aggregation audit surfaced it — `blocked` was originally missing from the terminal-failure classification `admit()` uses).
2. **Plan-level status aggregation** (`59a712d`) — `approved → running → complete/partial` (design/06 §2.4), a kernel-owned projection keyed `plan.id@plan.version`, never mutating the input `TaskPlan`.
3. **Pre-dispatch approval enforcement** (`bafab45`) — `admit()` now actually calls the C12 validator (`validate.ts`'s `validateDispatchApprovals`, previously only exercised by tests directly).
4. **Escalation lifecycle records** (`ead459c`) — a real `Escalation` object (`id, unitId, klass, raisedAt, resolvedAt, resolution`) and `resolveEscalation()`, recording the escalation paths that already existed (`capability_denied`, `indeterminate`) rather than only emitting a bare event.
5. **Attempt retry/exhaustion/escalation** (`874c035`) — `admit()` now makes the `attempt_failed → ready | exhausted → escalated | escalated` decision (design/06 §2.1), using the pre-existing `canRetry()`/`noProgress()` (previously correct but never called by the kernel itself). **Deliberately preserved, not changed:** `attempt_failed` is never auto-promoted at failure time — `postExecution` still just sets it and stops; the decision fires only when `admit()` is next called on that unit. This is load-bearing (`T-F10`, `T-F13` assert `attempt_failed` persists through one failed attempt with no `admit()` call) and confirms retry is **caller-driven**, not kernel-automatic — nothing in `kernel.ts` launches a second attempt by itself, anywhere.
6. **Unit rejection and cancellation** (`381f969`) — `reject(unitId, artifactId)` (`awaiting_approval → rejected`, mirrors `accept()`'s hash-binding but consumes a `reject` decision) and `cancel(unitId, reason)` (`{validated, ready, blocked, attempt_failed, awaiting_approval} → cancelled`, deliberately excluding `running`/`verifying` — proven architecturally unreachable, not merely unhandled: `runAttempt()` is a single synchronous call with no yield point, so nothing can call `cancel()` while a unit is genuinely mid-attempt). `abandoned` (cut short, never evaluated) vs `rejected` (evaluated and failed) is preserved exactly per Note 02 §13 — `cancel()` only ever produces `abandoned` artifacts, `reject()` only ever produces `rejected` ones. Descendant-blocking and plan-aggregation-to-`partial` needed **zero new code** — both mechanisms already treated `cancelled`/`rejected` as terminal-failure statuses since increment 1/2, before anything could produce them; `T-D18`/`T-D19` prove this empirically, not by inspection.

**Evidence trail worth knowing about before touching this area again:** three multi-turn audits preceded implementation for the DAG, retry, and plan-cancellation-scoping work specifically, each surfacing a real behavioral gap between what the proposed plan assumed and what the call graph actually did (the `blocked`-propagation gap; the `attempt_failed`-timing constraint; and — for the still-unimplemented plan-cancel cascade, §11 — `recomputePlanStatus`'s idempotency guard not yet accounting for `cancelled`). Re-derive from the repository, don't assume the shape of the *next* gap matches these.

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

**Deliberately not implemented in Slice 01's own checklist scope** (per `SLICE-01-acceptance-checklist.md` §O, still true of the 80 checklist tests themselves): architect Role and constraint compilation · any C2 criterion or model verifier · planner Role · multi-node DAG and artifact edges · class promotion rules · Memory beyond the zero-record case · non-trivial instance policy composition · escalation flow and attention policy · quorum > 1 in practice · `approve_with_conditions` · budget-increase approval · fleet layer · `RankSpec` · scheduling priority · `constraint_cases` in the eval suite. **Two of these — multi-node DAG/dependency edges, and escalation flow — are now implemented at the kernel level as Phase 1 Foundation (§3a).** Slice 01's own plan/tests remain single-node and don't exercise them; this is Slice 2 extending the kernel underneath Slice 01, not a change to Slice 01's contract.

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

**Phase 1 Foundation is frozen (§1, §3a). Do not implement Phase 2 work — including the known-next item below — without explicit instruction in the session.** Recording what's already known below is not the same as authorization to build it; it exists so a session doesn't have to re-derive from zero, not so it can skip asking.

**Known next architectural slice (audited, not implemented): plan-level cancellation with cascade to member `WorkUnit`s.** `TaskPlan.status` is typed `cancelled` (`types.ts`) but the kernel never assigns it — same "declared, never wired" pattern as every Phase 1 Foundation increment, one layer up. `design/06` §2.1's WorkUnit-cancel trigger *"human, or kernel on parent-plan failure"* has its second clause entirely unimplemented: nothing today lets a human cancel a whole plan and have the kernel cascade that to its still-active member units. A full read-only audit exists for this (contract, transition table for 15 scenarios, test plan, risk finding) but is not preserved anywhere in this repo outside that conversation — re-derive it if it matters, don't assume this paragraph is a substitute for doing so.

**Known unresolved decision, not resolved by design text:** when a plan-level cancellation cascades, should it proactively force *descendants* of a cascaded unit to `blocked` (mirroring how Escalation's row explicitly says `descendants → blocked`, `design/02` §13) — or is that unnecessary, since a full-plan cascade already reaches every member node directly regardless of edges, making explicit descendant-walking redundant for units *inside* the same plan? `design/02` §13's Cancellation row is silent on descendants (unlike its Escalation row, which says so explicitly) — this is a genuine gap in the design text, not an oversight to paper over. Also found during that audit, worth fixing as part of whichever slice touches this: `recomputePlanStatus`'s existing idempotency guard (`kernel.ts`) checks for `'complete'`/`'partial'` but not `'cancelled'` — a plan cancellation could in principle be silently overwritten by a later recompute call until this is closed.

The prior increments (§3a) established a working pattern for this kind of gap: grep for a status/field/type declared but never constructed or called, verify the call graph (not just the definition) before assuming a proposed fix's shape is correct, wire it into the smallest existing entry point rather than adding new machinery, and re-run the full suite before *and* after to catch load-bearing assumptions the audit alone might miss. That's a precedent, not a queue — the actual next gap still has to be re-derived, not assumed to be next in some list.

---

## 12. Prohibitions

Without explicit instruction, do **not**:

1. Redesign the architecture, or reopen a decision recorded as applied in the ledger.
2. Create new design notes. The architecture pass is closed; changes are **amendments**.
3. Implement deferred multi-instance or fleet features (C1, C2b, C4, D7). The resolver seam is the only part that exists.
4. Add organisation Roles — architect, planner, verifier — for demonstration or completeness. Slice 01 has exactly one Role, and its instance policy admits only that one.
5. Introduce a C2 / model-judged gate, or an escalation path, into Slice 01. `T-M4-scope` asserts their absence mechanically.
6. Replace a deterministic mechanism with LLM reasoning. The kernel contains no model call, and validation, resolution, harvest, and gate routing must stay deterministic.
7. Weaken a security boundary: executor credentials, network egress, capability scoping, the closed gate-context enumeration, or private-segment reachability.
8. Modify `rental-intel/`.
9. Commit, push, force-push, or rewrite history without being asked — even though this is now an established git repository (§3, §9), each of those remains an explicit-instruction-only action.
10. Edit a test to make a failing build green.
11. Implement Phase 2 work — including plan-level cancellation/cascade, the known-next item recorded in §11 — without explicit instruction in the session. Phase 1 Foundation (§3a) is frozen; being the audited, obvious next candidate is not the same as being authorized.

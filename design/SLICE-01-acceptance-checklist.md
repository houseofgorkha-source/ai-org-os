# AI-Org OS — Slice 01 Implementation Acceptance Checklist

**Derived from:** `SLICE-01-proposal.md`. **Scope unchanged.** No new components, Roles, gates, tools, or architecture.
**Status:** Acceptance criteria for implementation. Nothing here is optional.

---

## Conventions

- **Test IDs** are `T-<section><n>`. Slice-level criteria `S1–S12` from the proposal map to tests in §N.
- **Pass/fail is binary and observable.** "Looks right" is not a pass condition. Where a test asserts absence, it must assert against a machine-readable structure, never a human reading output.
- **Every test is automated** except `T-J1` (human approval), which is manual with a recorded artifact.
- A component is **done** only when its test passes *and* its failure-mode test fails correctly — a test that has never failed proves nothing (Note 03 §8).

---

## A. Registry and configuration

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| A1 | **Tool registry** | 4 registered tools (`fs.read`, `fs.write`, `shell.exec`, `git.commit`), each versioned, owned, signed, with `effects` declared and `must_succeed` / `must_deny` / `must_error` fixtures | Registering a tool without a `must_deny` fixture is refused; an unsigned tool cannot be referenced | `T-A1` | Fail-open action surface: a tool whose scope check never rejects | **Pass:** all 4 active; every fixture green. **Fail:** any tool active without negative coverage, or any unsigned tool resolvable |
| A2 | **`effects` enforcement** | `effects` on every tool; `external_effects: false` in the capability profile | Minting a token for a tool declared `effects: external` is rejected at mint time, not at call time | `T-A2` | A dangerous tool granted because nobody remembered it was dangerous | **Pass:** synthetic `effects: external` tool is refused at minting. **Fail:** refusal happens later, or not at all |
| A3 | **Gate registry** | 6 gates + `approval.merge`, each versioned, owned, signed, with `pass_means` stated and `must_pass` / `must_fail` fixtures; C0 gates carry a determinism check | Registering without a `must_fail` fixture is refused; two runs of a C0 gate on one fixture yield identical evidence hashes | `T-A3` | A gate that passes everything — stub, moved path, silently short-circuiting predicate | **Pass:** all 7 active, determinism check green. **Fail:** any gate active without negative coverage, or C0 evidence hash unstable |
| A4 | **`requires_context` closure** | The enumeration is closed and contains no memory source | A gate declaring a source outside the enumeration is refused at registration | `T-A4` | Advisory content entering the enforcement path | **Pass:** synthetic gate declaring `memory_store` is refused. **Fail:** it registers |
| A5 | **CapabilityProfile** | `code_writer@1.0.0`, `composition: intersect_only` | A profile edit that widens any scope or permission is rejected at publication | `T-A5` | The lattice inverting — instance config granting more than the Role allows | **Pass:** widening edit refused; narrowing edit accepted. **Fail:** widening accepted |
| A6 | **GateProfile** | `mechanical_change@1.0.0`, `composition: union_only` | No syntax exists to remove a binding; adding one from another layer succeeds | `T-A6` | Governance weakened by configuration | **Pass:** no removal path exists in the schema. **Fail:** any layer can drop a gate |
| A7 | **Role publication** | `implementer@1.0.0`, all refs pinned and resolvable | Publication is refused when `eval_suite` has not passed, and again when human approval is absent | `T-A7` | Production config shipped untested | **Pass:** both refusals fire independently. **Fail:** either can be bypassed |
| A8 | **Eval suite** | `implementer_evals@1.0.0`: 2 `capability`, 1 `refusal`, 0 `constraint` cases; fixtures pinned to commits | Suite runs at publication; a `refusal` case that produces a diff instead of an escalation fails the suite | `T-A8` | A Role that confabulates on an ambiguous spec | **Pass:** suite verdict `pass`; refusal case genuinely gates. **Fail:** suite has no refusal case, or it cannot fail |

---

## B. Intent and plan

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| B1 | **`Intent`** | `int_001`, human-raised | Resolvable from `TaskPlan.intent_ref` | `T-B1` | Untraceable work | **Pass:** lineage query returns the intent. **Fail:** any unit lacks an intent chain |
| B2 | **`TaskPlan` artifact** | `plan_001@1.0.0`, human-authored, with `plan` (public) / `decomposition_rationale` (restricted) / `reasoning_trace` (private) segments | Stored as a real `Artifact` with a content hash, not as loose config | `T-B2` | A plan that cannot be approved against a hash | **Pass:** schema-valid, hashed, segment visibility enforced. **Fail:** any segment mis-classed |
| B3 | **Node materialisation** | Key `(plan_001@1.0.0, n1)` | Re-running materialisation produces the same WorkUnit, not a second one | `T-B3` | Duplicate units after a retry of dispatch | **Pass:** second call is a no-op returning the existing unit. **Fail:** a second unit appears |

---

## C. Kernel validation (pre-dispatch, deterministic, no model call)

Each row is a **rejection test**: build a plan that violates the rule, assert it is refused *before* any token is spent.

| # | Rule | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|
| C1 | Authored graph is acyclic | `T-C1` | A plan that cannot terminate | **Pass:** cyclic plan rejected |
| C2 | No `resource` edge is authored | `T-C2` | Planner authoring conflict edges it cannot reliably see | **Pass:** authored `resource` edge rejected |
| C3 | Every `role_ref` admitted with `may_appear_in_plans: true` | `T-C3` | Unadmitted Role running work | **Pass:** plan naming `architect` or `planner` rejected |
| C4 | No `role_ref` that appears as any active gate's `execution.role_ref` | `T-C4` | Verification scheduled as a plan node | **Pass:** plan naming a verifier Role rejected |
| C5 | No node declares `class: verification` | `T-C5` | A class that does not exist | **Pass:** rejected |
| C6 | `expected_output == role.produces` | `T-C6` | Type mismatch discovered at runtime | **Pass:** mismatched plan rejected |
| C7 | Every criterion names a resolvable, active `gate_ref`, and `gate.criterion_class == criterion.class` | `T-C7` | Misclassified criterion — usually optimistic | **Pass:** C1 criterion bound to a C2 gate is rejected |
| C8 | **≥1 criterion is C0 or C1** | `T-C8` | A unit with nothing mechanically checkable | **Pass:** all-C2/C3 plan rejected |
| C9 | No input requests a `private` segment | `T-C9` | Reasoning laundered into context | **Pass:** rejected |
| C10 | `intent_ref` resolves to an `Intent`, never a `MemoryRecord` of kind `objective` | `T-C10` | Objective used as a backdoor Intent | **Pass:** rejected |
| C11 | `budget_aggregate` ≤ instance remaining | `T-C11` | Overcommitted plan | **Pass:** rejected |
| C12 | Blocking pre-dispatch approvals present and bound to this spec hash | `T-C12` | Work starting before approval | **Pass:** unapproved plan never reaches `ready` |

**Global pass condition:** every C-rejection occurs at `status: invalid` with **zero model calls recorded**. A rejection that costs a token is a fail.

---

## D. Resolution and dispatch

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| D1 | **`ResolvedExecutionSpec`** | Flattened bundle with `intersect`/`union`/`min` applied, hashed, `resolved_from` preserved | Recomputing from sources reproduces the stored hash | `T-D1` | Config drift between planning and dispatch | **Pass:** hash matches; mismatch fails validation. **Fail:** spec resolved at execution time |
| D2 | **Resolver seam** | Tier binding, floor, and attention budget read through a resolver, never from the instance object directly | Static check: no call site reads these fields directly | `T-D2` | Multi-tenancy becoming a rewrite at instance #2 | **Pass:** zero direct reads. **Fail:** any direct read |
| D3 | **Lease** | Compare-and-set on `(work_unit_id, epoch)` | Two concurrent schedulers: exactly one dispatches | `T-D3` | Two executors on one unit | **Pass:** loser does not dispatch. **Fail:** both proceed |
| D4 | **Admission control** | Conflict edges derived from `affected_paths`; per-Role and per-instance concurrency counted | A second unit with overlapping scope stays `ready` rather than running | `T-D4` | Concurrent units corrupting one workspace | **Pass:** admission deferred, not locked. **Fail:** both admitted |

---

## E. Context

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| E1 | **Context Compiler** | Deterministic pipeline, no model call | Same manifest inputs → identical `assembled_hash` | `T-E1` | Unreproducible context | **Pass:** two compiles byte-identical. **Fail:** any variance |
| E2 | **Memory layer with zero records** | `memory` layer present, `required: false`, `on_miss: omit`, priority 5 | Compilation succeeds on an instance with no memory | `T-E2` | A new instance unable to run at all | **Pass:** compiles, layer omitted. **Fail:** compilation error |
| E3 | **Rendering contract** | Every layer block carries name, **authority tier**, provenance | Parse the rendered context: zero unlabelled blocks, zero content outside a block | `T-E3` | Unattributable context — precedence that exists only in the compiler | **Pass:** 100% of blocks labelled. **Fail:** any bare content |
| E4 | **Truncation announced** | Explicit notice naming count and policy | Force a layer over its cap; assert the notice is present and names the count | `T-E4` | Model reasoning about code that is not there | **Pass:** notice present, content not truncated silently. **Fail:** silent trim |
| E5 | **Manifest** | Records layer hashes, source versions, truncations, `assembled_hash` over the **rendered** output | Hash changes when rendering changes but layers do not | `T-E5` | Two renderings treated as one context | **Pass:** hash is over rendered output. **Fail:** hash over layer set |

---

## F. Execution

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| F1 | **Capability token** | Bound to one attempt, expiring ≤ deadline, opaque to the executor | Presenting a token from another attempt is refused | `T-F1` | Token replay across attempts | **Pass:** refused on `spec_hash`/attempt mismatch. **Fail:** accepted |
| F2 | **Tool Broker** | Verifies the token on **every** call; enforces scope, rate limits | A write to `test/**` (outside `src/**`) is denied though `fs.write` is granted | `T-F2` | Coarse per-tool grants instead of per-scope | **Pass:** denied. **Fail:** allowed |
| F3 | **Denial path** | `DenialRecord` returned with `reason` and `granted_scopes`; denial budget enforced | `net.fetch` denial: executor receives structured refusal, adapts, continues | `T-F3` | Denials read as errors, or as silent failures | **Pass:** one denial, attempt continues, denial recorded. **Fail:** attempt aborts or denial is unlogged |
| F4 | **Denial budget** | N denials → `denial_budget` → `capability_denied` → **escalate, never retry** | Force 5 denials; assert escalation carries denied *and* granted scopes | `T-F4` | Unbounded probing of the permission surface | **Pass:** escalates with both scope sets, zero retries. **Fail:** retries |
| F5 | **Model Broker** | Holds all provider credentials; meters at the call boundary; records `model_served` per call | Executor process holds no credential; `model_served` recorded per call incl. fallback | `T-F5` | A metered party reporting its own meter; exfiltration route | **Pass:** zero credentials in executor env; per-call `model_served`. **Fail:** either absent |
| F6 | **No egress** | `network.egress: none` | Direct socket attempt from the executor fails | `T-F6` | Prompt-injected exfiltration | **Pass:** no route off the box, including to the model provider. **Fail:** any route |
| F7 | **`ExecutorResult` shape** | No artifact, no verdict, no status, no cost fields | Schema assertion on the returned structure | `T-F7` | Executor self-reporting output or success | **Pass:** those fields do not exist in the type. **Fail:** any present |

---

## G. Workspace and harvest

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| G1 | **Workspace lifecycle** | One per attempt, from a pinned commit, never shared or reused | Attempt 2 runs in a fresh workspace from the same baseline | `T-G1` | State leaking between attempts | **Pass:** no artefact of attempt 1 present. **Fail:** any carry-over |
| G2 | **Freeze** | Read-only at executor exit | Post-exit write attempt fails | `T-G2` | Mutation after measurement | **Pass:** refused. **Fail:** succeeds |
| G3 | **Kernel-side harvest** | Diff computed by the kernel from workspace vs baseline | The `CodeDiff` is byte-identical to a re-harvest | `T-G3` | Executor omitting or misdescribing its own changes | **Pass:** identical content hash. **Fail:** any divergence |
| G4 | **Out-of-scope surfacing** | Changed paths outside `affected_paths` are **included and flagged** | Plant a change under `test/**`; assert `locality.confined` fails and names the path | `T-G4` | Silent filtering hiding a scope violation | **Pass:** gate fails loudly with the path. **Fail:** path filtered out |
| G5 | **Disposal** | Destroy on success; **preserve** on failure/cancel/timeout | Failed attempt 1's workspace is present and inspectable | `T-G5` | Losing the evidence of a failure | **Pass:** preserved, never merged. **Fail:** destroyed |

---

## H. Verification

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| H1 | **Four-valued verdicts** | `pass` / `fail` / `indeterminate` / `error` | Each is producible and routed differently | `T-H1` | Infra noise burning a unit's attempts | **Pass:** all four distinguishable. **Fail:** any collapsed |
| H2 | **`error` ≠ `fail`** | `error` → `gate_errors[]`, consumes no attempt, produces no `FailureRecord` | Kill a gate runner mid-run; assert attempt count unchanged | `T-H2` | A flaky runner reading as a bad generator | **Pass:** attempt not consumed. **Fail:** consumed |
| H3 | **`indeterminate`** | Escalates; never retried blindly; never coerced | Force quorum disagreement on `tests.affected_pass` | `T-H3` | Re-running until green | **Pass:** `indeterminate` + escalation, not majority. **Fail:** majority taken |
| H4 | **Ordering** | Stage-ascending by cost | Execution order recorded and matches profile order | `T-H4` | Paying for expensive checks on broken input | **Pass:** stages in order. **Fail:** out of order |
| H5 | **Batch cheap, short-circuit expensive** | On blocking `fail`, finish current + cheaper stages; skip later ones | Attempt 1's `FailureRecord` contains all stage 1–2 results **and** the stage-3 failure | `T-H5` | Serial rediscovery — five attempts fixing one issue each | **Pass:** ≥5 gate results recorded on a single failing attempt. **Fail:** only the first |
| H6 | **Quorum** | `3/3` on `tests.affected_pass` | Three runs recorded per evaluation | `T-H6` | Flake absorbed as a pass | **Pass:** 3 runs, unanimity required. **Fail:** single run |
| H7 | **Predicate evaluation** | `applies_when: artifact.type == CodeDiff`; coverage report at publication | Predicate evaluates; `ZERO_COVERAGE` reported for a path term matching nothing | `T-H7` | An autonomy guard that can never fire | **Pass:** coverage report produced, zero-match term flagged. **Fail:** no report |
| H8 | **Evidence visibility ceiling** | Evidence inherits max visibility of what it quotes | A gate quoting a `restricted` segment yields a `restricted` `GateResult` | `T-H8` | Private content laundered through verification | **Pass:** visibility escalates correctly. **Fail:** stays public |

---

## I. Failure and retry

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| I1 | **`FailureRecord` whitelist** | No field capable of holding narrative | Schema assertion: no `notes`, `hypothesis`, `what_i_tried`, `summary` | `T-I1` | Fluent wrong reasoning re-entering the loop pre-endorsed | **Pass:** those fields do not exist in the type. **Fail:** any present |
| I2 | **Retry evidence** | `prior_attempt_evidence` bound to the `FailureRecord` only | **Inspect the rendered context of attempt 2**; assert attempt 1's `raw_trace_ref` content appears nowhere | `T-I2` | Anchoring on a known-bad hypothesis | **Pass:** zero narrative bytes from attempt 1. **Fail:** any present |
| I3 | **Same spec hash** | Retry reuses attempt 1's `ResolvedExecutionSpec` hash | Recorded spec hashes are equal | `T-I3` | Silent config change mid-contract | **Pass:** equal. **Fail:** differs |
| I4 | **No-progress detection** | Hash of `(failed_criteria, gate_verdicts, diff_summary)` per attempt | Two identical-shaped failures → escalate, no third attempt | `T-I4` | Money spent reconfirming a wrong spec | **Pass:** escalates at the second identical hash. **Fail:** third attempt runs |
| I5 | **Contract immutability** | Retry creates an `Attempt`, never mutates the `WorkUnit` | `acceptance_criteria` byte-identical before and after retry | `T-I5` | A unit softening its own criteria until it passes | **Pass:** unchanged. **Fail:** any mutation |

---

## J. Approval and merge

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| J1 | **Merge approval** | `1 of 1` quorum bound to `diff_002`'s content hash | Manual approval recorded as an `Approval` artifact | `T-J1` *(manual)* | Approval of a moving target | **Pass:** merge occurs only after approval. **Fail:** merge without one |
| J2 | **Hash binding** | Approval voids on any content change | Amend the diff post-approval; assert merge is blocked | `T-J2` | "Approved in spirit" | **Pass:** blocked, approval void. **Fail:** merge proceeds |
| J3 | **Human-only creation** | No code path creates an `Approval` | Static check + attempted programmatic creation | `T-J3` | The one forgery that invalidates every other guarantee | **Pass:** no path exists. **Fail:** any path |
| J4 | **Missing approval is a validation failure** | Unit does not start | Remove the plan approval; assert the unit never reaches `running` | `T-J4` | Decisions made under pressure with work in flight | **Pass:** never dispatched. **Fail:** runs then blocks |

---

## K. Events, replay, and recovery

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| K1 | **Event stream** | Every state transition emitted; all queryable state is a projection | Rebuild all state from events alone; compare to live state | `T-K1` | State and audit log drifting apart | **Pass:** rebuilt state identical. **Fail:** any divergence |
| K2 | **Causation / correlation** | `causation_id` and `correlation_id` on every event | Given the failing gate result, walk the causation chain back to `int_001` | `T-K2` | Investigation degrading to a timestamp scroll | **Pass:** unbroken chain. **Fail:** any gap |
| K3 | **Denials recorded** | Denied tool calls recorded with the same fidelity as granted ones | `T-F3`'s denial present in the stream | `T-K3` | Capability/objective mismatch invisible | **Pass:** present with reason and scopes. **Fail:** absent |
| K4 | **Replay mode 1 (audit)** | Full capture set persisted | For **both** attempts, reconstruct exactly what the model saw and every decision made — no model call | `T-K4` | Unfalsifiable failure investigation | **Pass:** complete for both attempts. **Fail:** any gap |
| K5 | **Replay mode 2 (context)** | Sources content-addressable or version-pinned | Recompile context from pinned sources; manifest hash matches | `T-K5` | An inadmissible source breaking replay forever | **Pass:** hash matches. **Fail:** mismatch or unpinned source |
| **K6** | **★ S10 — crash recovery** | Kernel restart scan for orphaned work | **Kill the kernel after executor exit and before harvest.** On restart: workspace preserved and frozen; harvest recomputes; content hash **identical**; no duplicate artifact; no re-spend | **`T-K6` (required)** | The cheap-crash case; and, if it fails, the whole kernel-side-harvest property | **Pass:** identical hash, zero duplicate artifacts, zero additional model spend, unit proceeds to gates normally. **Fail:** any divergence, duplicate, or re-spend |
| K7 | **Orphan sweeps** | A sweep for every orphanable state: `completed`-without-harvest, expired lease with `running` attempt, reservation held by a terminal attempt | Each sweep independently triggerable and observable | `T-K7` | Work **stuck rather than failed** — invisible, because nothing errors | **Pass:** all three sweeps present and firing. **Fail:** any state with no sweep |
| K8 | **Fencing** | Superseded attempt's workspace disposed **without harvest** | Force a lease expiry and a second dispatch; let the first executor finish | `T-K8` | Two artifacts for one unit | **Pass:** first workspace disposed unharvested, `superseded`, no attempt consumed. **Fail:** it harvests |

---

## L. Budget

| # | Component | Must exist | Observable proof | Test | Failure mode exercised | Pass / Fail |
|---|---|---|---|---|---|---|
| L1 | **Spend-point rule** | Decrement at the broker, durably, before returning | Crash mid-attempt; recorded spend matches actual provider spend | `T-L1` | A crash-retry loop spending without bound | **Pass:** spend recorded and retained. **Fail:** spend lost or deferred to success |
| L2 | **Failed-attempt cost retained** | Attempt 1's cost stays on the ledger | Cost-per-accepted-change includes it | `T-L2` | A ledger that lies, making cost metrics meaningless | **Pass:** retained. **Fail:** refunded |
| L3 | **Reservation** | Pessimistic reserve at dispatch; release at terminal | Instance headroom drops by the ceiling, not the actual | `T-L3` | Concurrent units jointly breaching the instance cap | **Pass:** reserve = ceiling; released at terminal. **Fail:** optimistic |
| L4 | **Split allocation** | `execution` and `verification` separate | `verification: $0.00` makes any model-gate call fail immediately | `T-L4` | Gate cost starving the work it judges | **Pass:** independent exhaustion. **Fail:** shared pool |
| L5 | **`fail_closed`** | No auto-extension | Exhaust a budget; assert escalation, not continuation | `T-L5` | A budget that is not a budget | **Pass:** stops and escalates. **Fail:** extends |

---

## M. Instrumentation

All five tier-1 measures must return non-null from unit zero — the point of building them now is the baseline.

| # | Measure | Must exist | Test | Pass / Fail |
|---|---|---|---|---|
| M1 | Cost per accepted change, per class | One `mechanical_change` data point | `T-M1` | **Pass:** non-null, and reconciles with `L1` spend |
| M2 | Per-gate catch rate and cost | 7 rows; `tests.affected_pass` catches 1, others 0 | `T-M2` | **Pass:** non-null for all 7. Zero-catch is a **baseline, not a verdict** |
| M3 | Gate `indeterminate_rate` per version | Recorded per gate version | `T-M3` | **Pass:** non-null. **Investigate** if >0 on slice 1 |
| M4 | Verifier-vs-human disagreement | Sampling harness **built and idle** (no C2 gate exists in this slice) | `T-M4` | **Pass:** harness exists and is exercised by a synthetic pass. **Fail:** deferred to later |

> **M4 is instrumentation-only.** Building and exercising the harness must **not** introduce a C2 gate, a model-judged verifier Role, or an escalation path into Slice 01. The harness reads `GateResult` rows and records a human agreement flag; it is exercised against a **synthetic, hand-written `pass` row**, not against any verifier output. If satisfying `T-M4` appears to require a verifier, the harness has been built at the wrong layer.
| M5 | Rework rate on accepted units | Denominator starts at 1 | `T-M5` | **Pass:** non-null |
| M6 | Denial rate per Role | Seeded with exactly 1 denial from `T-F3` | `T-M6` | **Pass:** reads 1 |

**Paired-reading rule enforced in the reporting layer:** M1 must not be displayed without M5; M2 cost must not be displayed without M2 catch rate.

---

## N. Slice-level criteria mapping

| Proposal criterion | Tests |
|---|---|
| S1 plan validated and rejections work | `T-B2`, `T-C1`–`T-C12` |
| S2 attempt 1 fails with full stage 1–2 evidence | `T-H5` |
| S3 retry carries structured evidence, no narrative | `T-I1`, `T-I2` |
| S4 denial returns structured refusal, attempt continues | `T-F3`, `T-K3` |
| S5 diffs byte-identical to re-harvest | `T-G3` |
| S6 replay mode 1 for both attempts | `T-K4` |
| S7 replay mode 2 reproduces manifest hash | `T-K5` |
| S8 rendering labelled; truncation announced | `T-E3`, `T-E4` |
| S9 budget spend-point, retention, release | `T-L1`, `T-L2`, `T-L3` |
| **S10 crash after exit, before harvest** | **`T-K6` (required)** |
| S11 merge only after hash-bound approval | `T-J1`, `T-J2` |
| S12 all tier-1 measures non-null | `T-M1`–`T-M6` |

---

## O. Explicitly not tested in Slice 01

Unchanged from the proposal. Absence here is scope, not oversight.

Architect Role · `ArchitectureDecision` and constraint compilation · any C2 criterion or model verifier · planner Role · multi-node DAG and artifact edges · class promotion rules · Memory (beyond `T-E2`'s zero-record case) · instance policy composition beyond trivial · escalation flow and attention policy *(nothing should escalate in slice 1 — if something does, that is the finding)* · quorum > 1 · `approve_with_conditions` · budget-increase approval · fleet layer (C1, C2b, C4, D7) beyond the resolver seam `T-D2` · `RankSpec` · scheduling priority · `constraint_cases` in the eval suite.

---

*End of Slice 01 acceptance checklist.*

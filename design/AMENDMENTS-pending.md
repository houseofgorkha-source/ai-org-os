# AI-Org OS — Pending Amendments Ledger

**Purpose:** Record of changes to the design notes. **The controlled application pass is complete.**
Design Notes 01–09 now reflect every `applied` entry below.

**Status values:** `proposed` (raised, not reviewed) · `accepted` (owner agreed, not yet applied) · `applied` · `rejected`

**MVP relevance:** `must-apply` (required before implementation) · `defer-to-instance-2` (multi-instance concern; design now, build later)

### Acceptance record

| Date | Decision | Entries | By |
|---|---|---|---|
| 2026-08-12 | Accepted. Architectural decisions adopted; **not applied**. | A1–A11, B1–B8 (19) | human:founder |
| 2026-08-12 | Reconciliation Pass 01 approved. C2 split, C3 clarified, C4/C5/D6 amended, V1→B9, V2+V3→B10, MVP relevance assigned. **Not applied.** | C1, C2a, C2b, C3, C4, C5, D1–D7, B9, B10 (15) | human:founder |

| 2026-08-12 | **Controlled application pass executed.** 30 applied to Notes 01–09; 4 held deferred. E1–E4 applied from Amendment Set E. | A1–A11, B1–B10, C2a, C3, C5, D1–D6, E1–E4 (34 applied) | assistant, per founder instruction |

**State: 34 applied, 4 accepted-deferred, 0 outstanding.**

**Deferred and NOT applied** (design recorded, build at instance #2): **C1** principal attention aggregation · **C2b** gate-registration quorum · **C4** fleet layer · **D7** `memory_policy`. Also deferred by decision, never amendments: `RankSpec`, planner strategy, scheduling priority, fleet binding table implementation.

The four open items at the foot of this document remain open by explicit instruction.

---

## Amendments to Design Note 01 (Role and Context Recipe)

| # | Section | Change | Raised by | Status | MVP |
|---|---|---|---|---|---|
| A1 | §2 `Role` schema | Replace inline `capabilities` / `capability_denies` / `permissions` blocks with a single `capability_profile_ref`. | Note 02 §0 | **applied** | must-apply |
| A2 | §2 `Role` schema | Replace `acceptance.mandatory_gates` with `gate_profile_ref`. Keep `acceptance.evidence_required`, `self_report_accepted`, `artifact_schema` inline. | Note 02 §0 | **applied** | must-apply |
| A3 | §2, §5 Model config | `model.candidates` moves out of `Role`. Role retains `tier`, `reasoning_effort`, `sampling_class`, `max_output_tokens`. Add a **fleet-level tier binding table** as a distinct object. | Note 02 §0 | **applied** | must-apply |
| A4 | §2 `Role` schema | Keep `on_failure` **inline**. Explicitly reject extraction as `FailurePolicy` — no composition operator, high semantic coupling to the Role. | Note 02 §0 | **applied** | must-apply |
| A5 | §6, §7 | These two sections become the `CapabilityProfile` specification. State `composition: intersect_only`. | Note 02 §0 | **applied** | must-apply |
| A6 | §9 Acceptance | Becomes the `GateProfile` specification. State `composition: union` and monotonic strengthening (Note 03 §9). | Note 02 §0, Note 03 §9 | **applied** | must-apply |
| A7 | §12, §13 Recipes | Recipe `assert_absent` exclusions are demoted to **defence in depth**. Primary independence mechanism is artifact segment visibility (Note 02 §5). Recipe layer definitions themselves unchanged. | Note 02 §5 | **applied** | must-apply |
| A8 | New section | Add `ResolvedExecutionSpec`, or forward-reference Note 02 §7. | Note 02 §7 | **applied** | must-apply |
| A9 | §17 deferred item 3 | Mark resolved. Constraint/criteria taxonomy delivered as C0–C3 (Note 02 §3) and the constraint form vocabulary (Note 03 §12). | Note 02 §3, Note 03 §12 | **applied** | must-apply |
| A10 | §9 Acceptance | Gate verdicts are **four-valued** (`pass` / `fail` / `indeterminate` / `error`), not boolean. `blocking` semantics defined in Note 03 §4. | Note 03 §4 | **applied** | must-apply |
| A11 | §9 Acceptance | Add: every gate in a profile must respect artifact segment visibility, and gate evidence inherits the maximum visibility of anything it quotes (Note 03 §5). | Note 03 §5 | **applied** | must-apply |

---

## Amendments to Design Note 02 (WorkUnit and Artifact)

| # | Section | Change | Raised by | Status | MVP |
|---|---|---|---|---|---|
| B1 | §3 `Criterion` | `check.verifier_role` is replaced by `check.gate_ref` for **all** classes. C2 gates name their executing Role inside the *gate* definition, not the criterion. Uniform binding across C0–C3. | Note 03 §1 | **applied** | must-apply |
| B2 | §11 `FailureRecord` | Add `gate_errors[]`, distinct from `gate_results[]`. A gate returning `error` is an infrastructure fault, **must not** produce a `FailureRecord`, and **must not** consume an attempt. | Note 03 §4 | **applied** | must-apply |
| B3 | §11 retry semantics | Add `indeterminate` handling: escalate, never retry, never count as failure. | Note 03 §7 | **applied** | must-apply |
| B4 | §6 `Attempt` | Model-judged gate executions produce their own `Attempt` records, parented to the gate execution WorkUnit rather than to the unit under test. | Note 03 §13 | **applied** | must-apply |
| B5 | §16 worked example | `wu_103` is reframed as the *execution of gate* `gate://review.independent` bound to criterion `b5`, not as a free-standing verification unit. Substance unchanged. | Note 03 §1 | **applied** | must-apply |
| B6 | §16 worked example | Constraint `c4` should have been compiled to a **C1 behavioural-equivalence** check at architecture-approval time rather than left as C2. See Note 03 §18 for the corrected trace and what it saves. | Note 03 §12 | **applied** | must-apply |
| B7 | §2 `WorkUnit` | `budget` gains a `verification` sub-allocation so gate cost cannot consume the execution allowance. | Note 03 §15 | **applied** | must-apply |
| B8 | §17.3 (who verifies the verifier) | Partially resolved **for deterministic gates only** — negative-fixture testing at registration (Note 03 §8). The model-judged case remains open. | Note 03 §8 | **applied** | must-apply |
| **B9** | §3 `Criterion`, §16 | *(was verification finding V1)* `check.approver` for C3 is removed alongside `check.verifier_role`. **All** classes bind via `check.gate_ref`; the approver lives in the gate's `execution.approver` (Note 03 §14). Completes B1. | Reconciliation 01 §1 | **applied** | must-apply |
| **B10** | §16 plan `plan_0091_v1` node `n3`; §16 `wu_103`; §17.1 | *(was V2 + V3, merged)* **Note 02 §16 treats verification as a plan-level concept, which Note 03 §1 eliminated.** Remove verification node `n3` from the example plan, and remove `class: verification` from `wu_103` — a class that also never appeared in §17.1's `WorkUnitClass` table. Verification attaches to criteria; the kernel derives the work. One amendment, because fixing either alone leaves the inconsistency. | Reconciliation 01 §2 | **applied** | must-apply |

---

## Amendments raised by Design Note 04 (Instance Policy)

| # | Section | Change | Raised by | Status | MVP |
|---|---|---|---|---|---|
| C1 | Note 02 §13 | Attention limits enforced against the **principal**, aggregated across all instances they own; instance policy may only narrow. Add `PrincipalAttentionBudget` at the fleet layer. Per-instance limits alone do not protect a human who owns several instances. **Interaction (C3):** a pending quorum approval counts against **every** named approver's budget, not only the eventual signers. | Note 04 §11 | accepted (deferred) | defer-to-instance-2 |
| **C2a** | Note 03 §19.5 | *(split from C2 — build now)* Gate definitions are **signed**; the kernel verifies signatures before execution. The registry has an append-only audit log outside any instance's reach. **No policy may reference an unsigned or unregistered gate.** Retrofitting signing later means re-registering every gate. Shares an enforcement point with D3 at gate registration. | Note 04 §14, Reconciliation 01 §2 | **applied** | must-apply |
| **C2b** | Note 03 §19.5, Note 04 §14 | *(split from C2 — deferred)* Gate registration **quorum**. Implemented as a `FloorPolicy` **value**, not a hardcoded 2 — default `1` at single-instance, raised to `2` when a second instance is provisioned. A hardcoded 2 would make a solo founder unable to register any gate. | Note 04 §14, Reconciliation 01 §2 | accepted (deferred) | defer-to-instance-2 |
| C3 | Note 02 §12 | `Approval` gains `quorum` (`N of M`) over a named approver set; single-approver becomes the degenerate `1 of 1` case. **Clarification 1:** all approvers bind to the **same content hash**; any content change voids **every** approval collected so far — no partial carry-forward. **Clarification 2:** a pending quorum approval consumes attention from every named approver (see C1). | Note 04 §4, §17; Reconciliation 01 §3 | **applied** | must-apply |
| C4 | Note 01 §13 | **Concept accepted; build deferred.** Name the **fleet layer** in the design — floor policy, model tier bindings, provisioning, principal attention budgets, registry trust root — so composition direction is documented and nothing precludes it. **Do not build it until instance #2 exists.** Required now: a **resolver seam** — nothing reads a tier binding, floor, or attention budget from the instance object directly; all go through a resolver that today returns instance values and later returns fleet∩instance. Building the layer at MVP would import multi-tenancy on day one. | Note 04 §2, §14; Reconciliation 01 §2 | accepted (deferred) | defer-to-instance-2 |
| C5 | Note 04 §9 | **Extended.** Class promotion rules validated against the bound repository at policy publication **and re-evaluated on repository change**. A predicate matching zero files is an instance **health signal**, not a gate; one matching zero files for a threshold period escalates to the policy owner. As originally raised (publication-time only) it would not have caught its own motivating scenario — a subsystem renamed months after publication. | Note 04 §19.5; Reconciliation 01 §2 | **applied** | must-apply |

---

## Amendments raised by the Memory pass (Boundary Proposal 04a + Design Note 05)

| # | Section | Change | Raised by | Status | MVP |
|---|---|---|---|---|---|
| D1 | Note 01 §6 | **Direct contradiction.** Note 01 defines four memory types; three are not Memory under Notes 02–04 (ground truth → repository, decision log → `ArchitectureDecision` artifacts, execution traces → `Attempt` + event log). Replace with the five kinds in Note 05 §2 and record where the others went. | 04a §10 | **applied** | must-apply |
| D2 | Note 01 §12, §13 | Recipes exclude "unapproved learned heuristics", implying approved ones are included, but define no memory layer. Add an explicit `memory` layer per Note 05 §8: lowest priority (never 1), hard token cap, `required: false`, `on_miss: omit`, subject to the precedence order. | 04a §10 | **applied** | must-apply |
| D3 | Note 03 §2 | `Gate.requires_context` omits memory by accident, not by rule. State the prohibition explicitly and enforce it at gate registration — a gate reading Memory would put advisory content into the enforcement path. Shares an enforcement point with C2a. | 04a §10 | **applied** | must-apply |
| D4 | Note 02 §12, Note 04 §11 (with C1) | Memory-commit approvals are **non-blocking** and excluded from the attention pause calculation. An unreviewed `MemoryProposal` simply never becomes Memory; nothing stalls. Otherwise Memory generates attention-budget pressure against real work and creates rubber-stamping reflex. Holds unchanged under C3 quorum. | 04a §10 | **applied** | must-apply |
| D5 | Note 02 §14 | State as a derived requirement: `MemoryRecord`s are immutable and versioned. Forced by the rule that every context source be content-addressable or version-pinned; mutable Memory breaks replay modes 1 and 2. | 04a §10 | **applied** | must-apply |
| D6 | Note 01 §4 | **Narrowed.** Do **not** create a general third category ("approved durable context") — it would have exactly one member, which is speculative generality. Instead, amend Note 01 §4 to state that its configuration/runtime dichotomy has **one named exception: Memory**, with Note 05 §3's properties (instance-scoped, versioned, immutable, non-deletable, human-approved, readable only by the Context Compiler). Collapsing `MemoryRecord` into `Artifact` was considered and rejected: "Artifact" means *output of work* across Notes 02–03, and `expired` has no artifact analogue. Generalise only if a second member appears. | Note 05 §14; Reconciliation 01 §2 | **applied** | must-apply |
| D7 | Note 04 §4, §18 | **`InstancePolicy` has no memory governance.** Add a `memory_policy` block under **Narrow/Oblige only** — `kinds_enabled`, `approval_bar_by_kind`, `max_expiry_by_kind`, `agent_proposals_enabled`, `memory_retention` — with no ability to loosen a Note 05 default. Without it a regulated instance cannot express "no agent-proposed heuristics". | Note 05 §14 | accepted (deferred) | defer-to-instance-2 |

---

## Verification findings — resolved

Raised while verifying A1–A11 / B1–B8 against Note 03. All three adjudicated in Reconciliation Pass 01.

| # | Finding | Resolution |
|---|---|---|
| V1 | Note 02 §3 `Criterion.check.approver` (C3) not covered by B1, though Note 03 §14 moves the approver into the gate | **Promoted to amendment B9** |
| V2 | Note 02 §16 plan `plan_0091_v1` contains verification node `n3`, eliminated by Note 03 §1 | **Merged with V3 → amendment B10** |
| V3 | Note 02 §16 `wu_103` declares `class: verification`, absent from §17.1's table and invalid under Note 03 §1 | **Merged with V2 → amendment B10** |

**Covered by implication, no entry required:** Note 02 §9 step 4 ("every C2 names an active `verifier_role`") is superseded by Note 03 §11's six-check validation list via B1.

---

## Application sequence

For the single controlled pass after the architecture pass completes.

| Wave | Entries | Rationale |
|---|---|---|
| **1 — Object model** | A1–A11, B1–B10, D6 | Everything downstream references these shapes |
| **2 — Verification** | C2a, D3, C5 | Gate registration enforcement points; apply together |
| **3 — Memory** | D1, D2, D4, D5 | Depends on wave 1's object model |
| **4 — Governance** | C3 | `Approval` shape; retrofitting quorum later is invasive |
| **Deferred** | C1, C2b, C4, D7 | Multi-instance. Design recorded; build at instance #2. C4's **resolver seam** is the only part required at MVP |

---

## Cross-cutting decisions confirmed, not amendments

Recorded so they are not re-litigated:

- `Role` holds no runtime state. (Note 01 §4)
- No supervisor / delegation field on `Role`; delegation is a validated `TaskPlan` artifact. (Note 01 §10)
- Retries create `Attempt`s and never mutate the `WorkUnit` contract. (Note 02 §1)
- Plans are immutable; replanning creates a new plan version. (Note 02 §8)
- Only a human principal may create an `Approval`. (Note 02 §12)
- Every context source must be content-addressable or version-pinned. (Note 02 §14)
- Extraction criterion is the presence of a **composition operator**, not object size. (Note 02 §0)
- Composition is monotonically strengthening at every level; instance policy may only Narrow, Oblige, and Bind. (Note 04 §2, §3)
- Isolation is structural, not policy: no object may name another instance. (Note 04 §13, Note 05 §9)
- Memory informs; it never constrains. The Context Compiler is its sole consumer. (Note 05 §7)

---

## Open items with no amendment yet

Kept open by explicit instruction.

| Item | Raised | Note |
|---|---|---|
| Criteria-quality gate | Note 02 §17.2 | The ceiling on the whole system. No solution proposed. |
| Code-comment leak through `public` diff segments | Note 02 §5, §17.5 | Unfixable by schema. Mitigations only. |
| Model-judged gate drift / rubber-stamping | Note 02 §17.3, Note 03 §19.2 | Sampled human audit of *passes* is the only proposed instrument. B8 resolves the deterministic case only. |
| `SelectorExpr` / `PredicateExpr` grammar | Note 01 §17, Note 02 §18, Note 03 §20, Note 04 §21, Note 05 §15 | Now serves four consumers: recipe selectors, gate `applies_when`, class promotion rules, memory scope matching. Longest-open item. |

---

*Ledger current as of Reconciliation Pass 01.*

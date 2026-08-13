# AI-Org OS — Design Note 02
## WorkUnit, Artifact, and Attempt

**Status:** Draft for review
**Scope:** Data model and semantics. No implementation, no storage or database decisions.
**Depends on:** Design Note 01 (Role and Context Recipe model)
**Amends Note 01:** Not yet. §0 proposes amendments; §17 lists exactly what would change if accepted.

---

## Table of contents

0. [First: is `Role` too large?](#0-first-is-role-too-large)
1. [The three runtime primitives](#1-the-three-runtime-primitives)
2. [The `WorkUnit` schema](#2-the-workunit-schema)
3. [Acceptance criteria: the checkability taxonomy](#3-acceptance-criteria-the-checkability-taxonomy)
4. [The `Artifact` schema](#4-the-artifact-schema)
5. [Segment visibility: exclusion as a capability, not a filter](#5-segment-visibility-exclusion-as-a-capability-not-a-filter)
6. [The `Attempt` schema](#6-the-attempt-schema)
7. [Pinning: the `ResolvedExecutionSpec`](#7-pinning-the-resolvedexecutionspec)
8. [DAG semantics](#8-dag-semantics)
9. [Kernel validation before execution](#9-kernel-validation-before-execution)
10. [Artifacts as inputs to downstream WorkUnits](#10-artifacts-as-inputs-to-downstream-workunits)
11. [Failure, retry, and the `FailureRecord`](#11-failure-retry-and-the-failurerecord)
12. [Human approval](#12-human-approval)
13. [Cancellation, timeout, exhaustion, escalation](#13-cancellation-timeout-exhaustion-escalation)
14. [Replayability](#14-replayability)
15. [What must NOT belong in `WorkUnit` or `Artifact`](#15-what-must-not-belong-in-workunit-or-artifact)
16. [Complete worked example](#16-complete-worked-example)
17. [Challenges to the current architecture](#17-challenges-to-the-current-architecture)
18. [Deferred questions](#18-deferred-questions)

---

## 0. First: is `Role` too large?

You proposed splitting `Role` into `ModelPolicy`, `CapabilityPolicy`, `ContextRecipe`, `AcceptancePolicy`, `FailurePolicy`, `EvalSuite`.

**My answer is: decompose, but not along those lines — and not for the reason implied.**

"Is this object too big?" is the wrong test. Size is a symptom, not a cause. Objects should be extracted when they need an independent lifecycle, independent governance, or — the decisive one — **when they need to compose with configuration from another layer**.

### The real criterion: does it have a composition operator?

An embedded field in an immutable record cannot be combined with anything. If instance policy needs to narrow a Role's permissions, or add a mandatory gate, or lower a budget, then the thing being combined must be a first-class named object — because you cannot intersect a field with nothing.

Apply that test and three composition operators appear, each demanding extraction:

| Sub-object | Operator | Composed with | Verdict |
|---|---|---|---|
| Capabilities + permissions | **intersect** — narrowing only, never widening | Instance policy, WorkUnit request | **Extract.** Strongest case. |
| Mandatory gates | **union** — adding only, never removing | Instance policy, WorkUnit, plan class | **Extract.** Strong case. |
| Budgets | **min** — lowest ceiling wins | Instance policy, plan remaining | Inline default + instance override object. |
| Context recipe | none (whole-object substitution) | — | Already separate. Correct, for lifecycle reasons. |
| Eval suite | none | — | Already a ref. Correct, for lifecycle reasons. |
| Failure policy | **none — nobody composes failure policies** | — | **Reject extraction.** |
| Model config | see below — the split is real but on a different axis | — | **Reframe.** |

### Verdict on each

**`CapabilityPolicy` — extract. This is the strongest case in your list, and I would merge capabilities and permissions into one object rather than two.**

Four independent reasons: (a) governance differs — a security owner should approve blast-radius changes, and whoever tunes a prompt should not be able to widen network egress in the same commit; (b) it needs `intersect` semantics against instance policy, which requires an object; (c) genuine reuse — many Roles share a "read-only, no egress, no secrets" profile; (d) it should be possible to answer *"which Roles can write to the repository?"* by reading a handful of small profiles, not by grepping thirty Role definitions. Security boundaries should be few, small, and separately auditable.

Splitting `capabilities` from `permissions` into two objects would be worse, not better. They answer the same question — blast radius — and separating them means a reviewer must hold two documents in their head to answer one question.

```yaml
CapabilityProfile:
  id, version, owner, description
  capabilities: [...]        # tool + scope + mode + rate_limit
  capability_denies: [...]
  permissions: { filesystem, repository, network, secrets, data, external_effects }
  composition: intersect_only    # declares that composition may only narrow
```

**`AcceptancePolicy` → `GateProfile` — extract.** Named, versioned, ordered gate sets that Roles reference and both instance policy and WorkUnits can extend. `union` semantics: the effective gate set is Role ∪ instance ∪ WorkUnit ∪ plan-class, and **no layer may remove a gate contributed by another**. This is what makes "a compliance instance requires a license check on every diff" expressible without editing any Role.

**`ModelPolicy` — reframe, don't extract as proposed.** The correct split is not by field category, it is **by who owns the decision**:

- **Role owns semantics** — `reasoning_effort`, `sampling_class`, `max_output_tokens`, and a `tier`. These express *what the work needs*, and only the Role author knows that.
- **The fleet owns the binding** — `frontier → [these three model versions, in this order]`. This changes when a model ships, a provider degrades, or cost pressure arrives. It is an operational decision, not a semantic one.

Extracting a `ModelPolicy` object per Role would leave you editing thirty objects on a model migration — exactly the problem `tier` existed to solve. What you want is one **fleet-level tier binding table** plus optional per-instance override. That is a different object than the one proposed, and it is better.

**`FailurePolicy` — reject extraction.** It is six enum fields, nobody composes it, and its correct values are tightly coupled to the Role's semantics — an architect's handling of `spec_ambiguous` is meaningfully different from an implementer's. Extracting it produces a versioned object with less content than its own header, and adds a version number to reason about for zero benefit. Keep it inline.

**`ContextRecipe` and `EvalSuite` — already separate, and correctly so**, but note the reason differs: neither has a composition operator, and neither has much reuse (a recipe serves one Role; an eval suite tests one Role). They are separate for **lifecycle** reasons — recipes are the highest-churn part of the system and are independently testable as pure functions; eval suites change when you learn about failure modes, not when you change the prompt. Lifecycle is a legitimate second criterion. It is just weaker than composition.

### Resulting shape

```
Role  (semantics: what class of work this is and how it is framed)
├── mandate, consumes, produces, emits_plan
├── prompt_ref                    →  separate  (lifecycle: versioned asset)
├── context_recipe_ref            →  separate  (lifecycle: high churn, pure-function testable)
├── capability_profile_ref        →  separate  (COMPOSITION: intersect)  ★
├── gate_profile_ref              →  separate  (COMPOSITION: union)      ★
├── eval_suite_ref                →  separate  (lifecycle)
├── model: { tier, reasoning_effort, sampling_class, max_output_tokens }
│                                    inline; tier resolved via fleet binding table  ★
├── budget_defaults               →  inline; min()'d against instance BudgetPolicy
└── on_failure                    →  inline  (no operator, high coupling)  ★
```

Net: **two extractions, one reframe, one rejection.** Not the six you proposed, and not zero.

### The cost of decomposition, and how §7 pays it

Six versioned references means "what was this Role, exactly, at 14:20 on the 3rd?" becomes a six-pointer chase across six version histories. That is a real regression in the property Note 01 cared most about — replayability.

The fix is in §7: the **WorkUnit pins a `ResolvedExecutionSpec`** — the fully flattened, composed, hashed bundle of every configuration object at their resolved versions, including the results of every intersect/union/min. Replay reads one hash. Composition happens once, at dispatch, deterministically, and the result is frozen.

This is why the decomposition question had to be answered before the WorkUnit schema, and why it is §0 rather than an appendix. **Decompose the authoring model; flatten the execution model.** Authors compose small governed objects; the runtime sees one immutable resolved spec.

---

## 1. The three runtime primitives

```
WorkUnit   — the CONTRACT.  What must be true when this is done. Immutable once dispatched.
Attempt    — the EXECUTION. What actually happened on try N. Append-only, 1:N under WorkUnit.
Artifact   — the RESULT.    A typed, hashed, immutable output. Never edited; superseded.
```

The load-bearing invariant, from which most of this document follows:

> **A retry creates a new `Attempt`. It never modifies the `WorkUnit`.**
>
> If the contract itself must change, that is a **replan** producing a *new WorkUnit*, not a retry.

Without this, retries drift: a unit that fails three times quietly softens its own acceptance criteria until it passes, and the log shows a success. Separating contract from execution makes that structurally impossible — there is no field on `Attempt` that can reach the criteria.

---

## 2. The `WorkUnit` schema

```yaml
WorkUnit:

  # ---- IDENTITY -------------------------------------------------------
  id:              WorkUnitId
  instance_id:     InstanceId          # never crosses; enforced below this layer
  plan_id:         PlanId              # the plan version that created this unit
  plan_node_id:    string              # position within that plan
  class:           WorkUnitClass       # see §17.1 — drives the mandatory pipeline
  created_at:      timestamp
  created_by:      Principal           # human | kernel | role_ref (via TaskPlan)

  # ---- INTENT ---------------------------------------------------------
  objective:       string              # ONE imperative outcome. Not a task list.
  intent_ref:      IntentId            # the originating human intent, for lineage

  # ---- CONTRACT -------------------------------------------------------
  inputs:
    - artifact_id:   ArtifactId
      content_hash:  Hash              # pinned; mismatch at dispatch = validation failure
      as:            string            # local name the recipe binds to
      segments:      [SegmentName]     # WHICH segments this unit may see (see §5)
  expected_output:   ArtifactType      # must equal role.produces
  acceptance_criteria: [Criterion]     # see §3 — typed, not prose
  constraints:                         # inherited, by reference, never restated
    - source_artifact: ArtifactId
      constraint_ids:  [string]        # e.g. ad_014 -> [c1,c2,c3,c4,c5]

  # ---- EXECUTION BINDING ----------------------------------------------
  execution_spec:  ResolvedExecutionSpec   # §7 — fully flattened and hashed

  # ---- GRAPH ----------------------------------------------------------
  depends_on:
    - unit_id:   WorkUnitId
      kind:      artifact | ordering | resource   # §8
  affected_paths: PathGlob[]           # declared scope; source of conflict edges

  # ---- LIMITS ---------------------------------------------------------
  budget:                              # resolved min(role, instance, plan_remaining)
    execution:     { input_tokens, output_tokens, tool_calls, wall_clock_s, cost }
    verification:  { cost, wall_clock_s, model_gate_calls }   # separate  [B7]
    # Verification has its own allocation so gate cost cannot consume the
    # execution allowance, and vice versa. Verification exhaustion is never a
    # `fail` — it is an escalation: verification could not complete. Treating an
    # unverified artifact as failed is wrong; treating it as passed is far worse.
    # Gate `error` verdicts consume neither, drawing on a separate gate-retry
    # allowance, because infrastructure faults are not work.  [B2]
  deadline:        timestamp?

  # ---- GOVERNANCE -----------------------------------------------------
  approvals_required:
    - kind:      ApprovalKind          # pre_dispatch | pre_merge | budget_increase
      subject:   enum                  # spec | artifact | budget
      blocking:  bool

  # ---- STATE (kernel-owned; contract fields above are immutable) -------
  status:          WorkUnitStatus
  attempts:        [AttemptId]         # ordered
  outcome:
    artifact_id:   ArtifactId?
    verdict:       enum?               # accepted | rejected | abandoned
    closed_at:     timestamp?
```

### Status lifecycle

```
     draft ──► validated ──► ready ──► running ──► verifying ──► awaiting_approval ──► accepted
       │           │            │          │            │                │
       │           │            │          ▼            ▼                ▼
       │           │            │      attempt_failed ──┴────────────► escalated
       │           │            │          │
       │           │            │          ├──► ready        (retry available)
       │           │            │          └──► exhausted    (attempts spent)
       │           ▼            ▼
       │       invalid       blocked   (an upstream dependency failed)
       ▼
   cancelled
```

`blocked` is deliberately distinct from `failed`. A downstream unit whose dependency failed did nothing wrong; marking it `failed` corrupts every quality metric you will later compute and makes the log unreadable.

### Field notes

| Field | Why it exists |
|---|---|
| `objective` as **one** imperative outcome | A unit with a task list inside it is an unvalidated plan hiding in a string. Decomposition belongs in the DAG where the kernel can check it. |
| `intent_ref` | Lets you ask "everything that came from this founder request" — the only lineage query that matters in practice. |
| `inputs[].content_hash` | Inputs are pinned by content, not by id. An artifact cannot change under a unit between validation and dispatch. |
| `inputs[].segments` | The mechanism from §5. A unit declares which parts of an input it may see; the compiler cannot address the rest. |
| `constraints` by **reference** | Restating a constraint in the unit creates a second copy that can drift from the governing decision. Reference and dereference at compile time. |
| `affected_paths` | Three jobs: scope declaration, conflict-edge derivation (§8), and the `files_touched` budget check. |
| `class` | Drives which pipeline is mandatory (§17.1). Without it, a typo fix gets the same three-stage ceremony as a schema migration. |
| `approvals_required` **on the unit** | Approval requirements are per-unit, derived from class and instance policy at plan time — visible in the plan a human approves, rather than discovered at runtime. |

---

## 3. Acceptance criteria: the checkability taxonomy

Note 01 deferred this (§17, item 3). Here it is, because the `WorkUnit` schema cannot be specified without it.

**A criterion is not a sentence. It is a typed object that declares how it will be checked.**

```yaml
Criterion:
  id:          string                  # c1, c2... stable within the unit
  statement:   string                  # human-readable
  class:       C0 | C1 | C2 | C3       # MANDATORY. See below.
  check:
    gate_ref:          GateId@SemVer   # ALL classes, uniformly  [B1, B9]
    parameters:        {…}
    evidence_required: [EvidenceType]
    # `verifier_role` REMOVED [B1] and `approver` REMOVED [B9].
    # Everything that decides a criterion is a Gate; only the SUBSTRATE differs.
    # A C2 gate names its executing Role in the gate's `execution.role_ref`;
    # a C3 gate names its approver in the gate's `execution.approver`.
    # See Note 03 §1, §11, §14.
  blocking:    bool
  derived_from: ConstraintRef?         # if inherited from an upstream decision
```

### The four classes

| Class | Name | Decided by | Example |
|---|---|---|---|
| **C0** | **Mechanical** | A program reading the artifact. No execution. | "No new runtime dependency." "Public API schema unchanged." "≤4 files touched." |
| **C1** | **Empirical** | Running something and observing. | "Tests pass." "4th request within 60s returns 429." "p99 under 200ms." |
| **C2** | **Model-judged** | A verifier Role citing evidence against the spec. | "Response is identical for existing and non-existent accounts." "Abstraction matches the governing decision." |
| **C3** | **Human-judged** | A named human. | "The UX of the failure state is acceptable." "This risk is worth taking." |

### Rules the kernel enforces

1. **Every criterion declares its class at authoring time.** A criterion without a class is not a criterion; it is a wish. Validation rejects it.
2. **Every criterion must name a `gate_ref`, whatever its class** [B1, B9]. If you cannot name the gate, the criterion is not actually checkable and you have misclassified it — usually optimistically. The kernel validates that `gate.criterion_class == criterion.class`; a mismatch is a validation failure, not a warning.
3. **A C2 gate's finding must cite evidence.** A verdict without a location and a reproduction is an opinion.
4. **A WorkUnit must have at least one C0 or C1 criterion.** ★ This is the highest-value validation rule in the document. A unit whose criteria are *entirely* C2/C3 has nothing mechanically checkable in it — which almost always means the objective is too vague or too large, and it should be re-decomposed before a token is spent. Rejecting it at validation costs nothing; discovering it after three model-verified attempts costs everything.
5. **Class is a floor, not a ceiling.** Adding a C0 check to something also judged at C2 is always welcome. Downgrading C1 to C2 because the test was hard to write is the failure mode to watch for, and it should be visible in review.

### Why criteria must be typed

Free-text criteria produce free-text verdicts, and free-text verdicts cannot be aggregated, gated, replayed, or trended. Typed criteria give you: pre-execution validation of spec quality, deterministic gate routing, a structured `FailureRecord` (§11), and — over time — a measurable answer to *"which criterion classes do we get wrong most often?"* That last one is how the system actually improves, and it is impossible with prose.

---

## 4. The `Artifact` schema

```yaml
Artifact:

  # ---- IDENTITY -------------------------------------------------------
  id:              ArtifactId
  instance_id:     InstanceId
  type:            ArtifactType            # ArchitectureDecision | CodeDiff | ...
  schema_ref:      SchemaRef               # pinned version; content validated against it
  content_hash:    Hash                    # over canonicalised content
  created_at:      timestamp

  # ---- CONTENT --------------------------------------------------------
  segments:                                # §5 — the key structure
    - name:       SegmentName
      visibility: public | restricted | private
      content:    any                      # or content_ref for large blobs
      hash:       Hash

  # ---- PROVENANCE -----------------------------------------------------
  produced_by:
    work_unit_id:  WorkUnitId
    attempt_id:    AttemptId
    role_ref:      RoleRef                 # role@version, not an actor identity
    execution_spec_hash: Hash
  inputs_hash:     Hash                    # over the pinned input artifact set
  context_manifest_ref: ManifestId

  # ---- STATE ----------------------------------------------------------
  status:          draft | verified | accepted | rejected | superseded | abandoned
  verification:
    gate_results:  [GateResult]
    verdict:       enum?
    verified_at:   timestamp?
  approvals:       [ApprovalId]
  supersedes:      ArtifactId?
  superseded_by:   ArtifactId?
```

### Invariants

1. **Artifacts are immutable.** Content and segment hashes are fixed at creation. Corrections create a new artifact with `supersedes` set. There is no edit path.
2. **Only `status`, `verification`, `approvals`, and `superseded_by` mutate** — and only the kernel writes them. No executor ever changes an artifact's status.
3. **`status: draft` cannot be consumed downstream.** Only `accepted` artifacts satisfy an `artifact` dependency edge.
4. **`inputs_hash` closes the provenance chain.** Given any artifact you can reconstruct the exact set of inputs that produced it, transitively to the originating human intent.
5. **An artifact whose schema validation fails is never created.** Failed validation produces an `Attempt` failure, not a bad artifact. Nothing invalid enters the store.
6. **`abandoned` ≠ `rejected`.** Rejected means it was evaluated and failed. Abandoned means execution was cut short (cancel/timeout/exhaustion) and it was never evaluated. Conflating them poisons quality metrics and, worse, makes partial output look consumable.

---

## 5. Segment visibility: exclusion as a capability, not a filter

**This is the central design contribution of Note 02, and it materially strengthens Note 01.**

Note 01 kept the verifier independent by *filtering* the implementer's reasoning out of the verification context, with `assert_absent` as a backstop. That is a **subtractive** defence: it is sound only if you correctly anticipate every path by which the content could arrive. Subtractive defences fail quietly and fail late.

Segments invert it. The artifact itself declares, at its schema, which parts are addressable by whom:

| Visibility | Who may address it | Purpose |
|---|---|---|
| `public` | Any downstream recipe | The contractual output. Decision, constraints, the diff. |
| `restricted` | Only recipes that request it **and** WorkUnits that list it in `inputs[].segments` | Useful but contaminating. Rationale, alternatives rejected. |
| `private` | **Nothing.** Audit, replay, and human inspection only. | Reasoning traces, self-assessment, confidence claims. |

Visibility is declared by the **artifact schema**, not by the producer. A Role cannot mark its own reasoning `public`, and a recipe selector cannot address a `private` segment — the selector grammar has no way to name it.

```yaml
schema://architecture_decision/1.0.0:
  segments:
    problem:               public
    decision:              public
    constraints:           public
    affected_paths:        public
    out_of_scope:          public
    rationale:             restricted     # architect's justification
    alternatives_rejected: restricted
    reasoning_trace:       private        # unreachable, always

schema://code_diff/1.0.0:
  segments:
    diff:                  public
    files_touched:         public
    gate_evidence:         public
    test_provenance:       public
    implementation_notes:  restricted
    reasoning_trace:       private
    self_assessment:       private        # unreachable, always
```

### Why this is better

- **Sound rather than best-effort.** Independence is enforced by the type system at the point of production, not by a filter that must anticipate every leak path.
- **The default is safe.** A new recipe author who forgets an exclusion still cannot see private segments. Under the filter model, forgetting is the failure.
- **It is auditable as a static property.** "Can any verification context ever contain implementer reasoning?" is answerable by reading two schemas — not by reasoning about the union of all recipes past and future.
- **Note 01's `assert_absent` rules survive as defence in depth**, which is the correct role for them.

### Where this boundary genuinely leaks — and it does

**A `CodeDiff`'s `diff` segment is `public`, and code contains comments.** An implementer that writes:

```js
// Keying before the lookup would be cleaner, but it breaks the existing
// test fixture, so we do it after and compensate below.
```

…has just moved its rationale — including a rationalisation of the exact defect the verifier is meant to catch — into a `public` segment the verifier is *required* to read. No schema can prevent this, because comments are part of the change under review and stripping them would corrupt the artifact.

Three partial mitigations, none complete:

1. Implementer prompt discipline: comments explain *what the code does*, never *what the author considered and rejected*. Weak — it is a prompt, not a boundary.
2. An advisory gate flagging comments containing justification markers ("but", "instead of", "would be cleaner", "chose to"). Noisy, but cheap and it makes the leak visible.
3. Verifier prompt discipline: treat comments as claims to be checked against the code, never as evidence about it.

**I want this named as a known, unclosed hole rather than buried.** It is the sharpest limit on the independence property, and any claim that verification is structurally independent is true of everything *except* the diff body.

---

## 6. The `Attempt` schema

```yaml
Attempt:
  id:              AttemptId
  work_unit_id:    WorkUnitId
  ordinal:         int                     # 1-based
  started_at, ended_at: timestamp

  # ---- WHAT ACTUALLY RAN ----------------------------------------------
  execution_spec_hash:  Hash               # resolved config that governed this attempt
  context_manifest_ref: ManifestId         # exactly what the model saw
  rendered_prompt_hash: Hash
  model_served:         ModelRef           # ACTUAL model + version, incl. fallback
  sampling_params:      {...}              # as sent
  capability_token_ref: TokenId            # what was actually minted, narrowed

  # ---- WHAT IT DID ----------------------------------------------------
  tool_invocations:
    - seq, tool_id, args_hash, scope_checked, result_hash,
      duration_ms, denied: bool
  consumption:
    input_tokens, output_tokens, tool_calls, wall_clock_s, cost

  # ---- OUTCOME --------------------------------------------------------
  status:            running | succeeded | failed | cancelled
                     | timed_out | budget_exhausted | denied
  produced_artifact: ArtifactId?
  failure:           FailureRecord?        # §11
  raw_trace_ref:     TraceId               # visibility: private. ALWAYS private.
```

### WorkUnit ↔ Attempt

| | WorkUnit | Attempt |
|---|---|---|
| Holds | The contract | The execution record |
| Mutability | Contract fields immutable after validation | Append-only, immutable once ended |
| Cardinality | 1 | N |
| Answers | "What must be true?" | "What happened on try 2?" |
| On retry | **Unchanged** | New record |

**`model_served` records the actual model, including fallback.** When a Role's primary candidate is degraded and attempt 2 silently ran on the secondary, that is very often the explanation for a behaviour change — and it is invisible unless recorded per attempt.

**`raw_trace_ref` is private, always.** It is the reasoning trace. It exists for human debugging and audit replay. Nothing in any context assembly path can address it, from any recipe, ever — and no predicate can name it (Note 08 §3). This is the enforcement point behind §11.

**Model-judged gate executions produce their own `Attempt` records** [B4], parented to the **gate execution WorkUnit** rather than to the unit under test. A C2 gate is not a function call: it costs money, needs a compiled context, needs a capability token, and can fail, time out, or exhaust a budget (Note 03 §13). Parenting its attempts separately keeps cost attribution honest — verification spend stays visible apart from implementation spend, which is what makes the class-pipeline economics in §17.1 measurable at all.

---

## 7. Pinning: the `ResolvedExecutionSpec`

Answering question 4, and paying the cost that §0's decomposition incurred.

At dispatch, the kernel resolves and **flattens** every configuration reference into one immutable, hashed bundle:

```yaml
ResolvedExecutionSpec:
  hash:               Hash               # over the entire flattened structure

  role_ref:           "implementer@2.0.1"
  prompt_ref:         "prompt://implementer/2.0.1"
  context_recipe_ref: "recipe://implementation/1.3.0"
  artifact_schema_ref:"schema://code_diff/1.0.0"

  # ---- COMPOSED RESULTS (operators already applied) -------------------
  effective_capabilities:              # role.profile ∩ instance ∩ unit_request
    resolved_from: [ "capprofile://code_writer/1.1.0",
                     "instance_policy://acme/4.2.0" ]
    capabilities:  [...]
  effective_gates:                     # role ∪ instance ∪ unit ∪ class
    resolved_from: [ "gateprofile://code_change/2.0.0",
                     "instance_policy://acme/4.2.0",
                     "class://bounded_change" ]
    gates:         [...ordered...]
  effective_budget:                    # min(role, instance, plan_remaining)
    resolved_from: [...]
    limits:        {...}
  model_binding:                       # tier resolved through fleet table
    tier: frontier
    resolved_candidates: ["<model-a@version>", "<model-b@version>"]
    binding_ref: "fleet_binding://2026-08-01"
  on_failure:       {...}              # inline from Role
```

### Rules

1. **Resolution happens exactly once, at dispatch, deterministically.** Never at execution time, never per attempt.
2. **The composition operators are applied and their results frozen.** The `resolved_from` lists preserve the derivation for audit — you can see *why* the capability set is what it is — but the runtime consults only the composed result.
3. **The unit stores the hash and the full flattened spec.** Replay reads one object. No pointer chasing, no version archaeology across six histories.
4. **Recomputation is a validation check.** At dispatch the kernel recomputes the spec from its sources and compares hashes. A mismatch means configuration changed between planning and dispatch, and the unit fails validation rather than running under a spec nobody approved.
5. **Retries reuse the same spec hash** — with one exception: a human-approved budget increase produces an amended spec, a new hash, and an `Approval` artifact recording the amendment. Budget increases are never silent.

> **Decompose the authoring model. Flatten the execution model.**
> Authors compose small, separately governed objects. The runtime sees one immutable resolved spec. This is the whole answer to §0's cost.

---

## 8. DAG semantics

### Three edge kinds

| Kind | Meaning | Constraint |
|---|---|---|
| `artifact` | B consumes A's output | A must reach `accepted`; B's inputs pin A's content hash |
| `ordering` | B must follow A but consumes nothing | A must reach a terminal state. Example: migration before the code that uses it. |
| `resource` | B and A contend for the same resource | Mutual exclusion, not precedence — see below |

### Conflict edges, derived not authored

`resource` edges are **derived by the kernel** from overlapping `affected_paths`, not written by the planner. Two units whose declared scopes intersect cannot run concurrently, regardless of what the plan says.

This is worth calling out because it is a class of bug the planner reliably produces: two units that are *logically* independent (different features) but *physically* conflicting (same file). The planner has no reliable way to see it; the kernel can compute it in microseconds. Derived edges also mean the planner cannot forget them.

### Rules

1. **Acyclic, validated as a whole graph before any node runs.** Cycles are a plan-authoring error, caught for free at validation cost.
2. **Plans are immutable.** No node may add edges or nodes at runtime. Replanning produces **plan v2** with explicit lineage to v1 and to the evidence that triggered it.
3. **Failure propagates as `blocked`, not `failed`.** Descendants of a failed node are blocked; they are not themselves failures.
4. **Fan-out concurrency is bounded by instance policy**, not by the plan. A 40-node plan does not get to spawn 40 concurrent executors.
5. **A node's failure does not automatically fail the plan.** Independent branches continue. The plan reaches `partial` and escalates with an explicit accounting of what completed and what did not.
6. **No cross-instance edges.** Not a validation rule so much as a structural impossibility, enforced below this layer.

### The `TaskPlan` artifact  [E1]

`TaskPlan` has been referenced since this note and remained informal. Its semantics were already fully specified — DAG rules above, no verification nodes (Note 03 §1), role admission (Note 04 §8), class pipelines (Note 04 §9). Only the field list was missing.

```yaml
Artifact:
  type: TaskPlan
  schema_ref: "schema://task_plan/1.0.0"
  segments:
    - { name: plan,                     visibility: public }
    - { name: decomposition_rationale,  visibility: restricted }
    - { name: reasoning_trace,          visibility: private }

TaskPlan:
  id, version, instance_id
  intent_ref:    IntentId

  supersedes:    PlanId@SemVer?        # plans are immutable; replanning versions
  superseded_by: PlanId@SemVer?
  replan_reason: { triggered_by: FailureRecordId | EscalationId | HumanDecision,
                   summary: string }

  nodes:
    - node_id, objective, role_ref, class, expected_output
      acceptance_criteria: [Criterion]
      constraints:  [{ source_node?, source_artifact?, constraint_ids: [string] }]
      affected_paths: PathGlob[]
      budget:       BudgetRequest
      approvals_required: [ApprovalRequirement]

  edges:
    - { from: node_id, to: node_id, kind: artifact | ordering }

  budget_aggregate: { execution: Money, verification: Money }
  status: draft | approved | running | complete | partial | cancelled
```

A plan's *rationale* is `restricted` and the planner's reasoning is `private`: a human approving a plan judges the decomposition, not the planner's account of it.

**Only `artifact` and `ordering` edges may be authored.** `resource` (conflict) edges are **derived by the kernel** from overlapping `affected_paths`, and a plan authoring one fails validation. The reason is the one given above: a planner cannot reliably see physical contention between logically independent nodes, so letting it author some invites it to miss others — and the kernel would then have to reconcile authored against derived.

**Node materialisation.** A node is not a `WorkUnit`. The kernel materialises one from a node at dispatch, exactly once per plan version, keyed `(plan_id@version, node_id)`. The node supplies objective, role, class, criteria, constraints, paths, and budget request; the kernel supplies `instance_id`, the `ResolvedExecutionSpec`, the effective budget after `min()`, and the derived conflict edges. Replanning materialises **new** units under the new plan version; nodes are never re-pointed.

**Validation** (extending §9 step 2 — all static, all pre-dispatch):

```
STRUCTURE   · every edge endpoint resolves; authored graph is acyclic
            · no `resource` edge is authored
ADMISSION   · every role_ref admitted with may_appear_in_plans: true
            · a role_ref appearing as any active gate's execution.role_ref
              MAY NOT be a plan node             ★ (Note 03 §1)  [B10]
            · no node declares class: verification              [B10]
TYPES       · per artifact edge: producer.produces ∈ consumer.consumes
            · every node's expected_output == its role's produces
CRITERIA    · every node has ≥1 criterion, each with a class and an active gate
            · every node has ≥1 C0 or C1 criterion            ★ §3 rule 4
            · every referenced constraint_id exists in its source
BUDGET      · budget_aggregate ≤ parent/instance remaining ceiling
LINEAGE     · replan_reason present iff supersedes is set
            · intent_ref resolves to an Intent, NEVER to a MemoryRecord
              of kind `objective`                ★ (Note 05 §2.6)
```

★ **The verification-node check is mechanically decidable.** A Role appearing as `execution.role_ref` in any active gate *is* a verification Role; it reaches work through gate execution, never through a plan. Checking plan roles against the gate registry makes "a plan can neither forget verification nor schedule it" a static property rather than a convention.

★ **The `intent_ref` check** enforces Note 05 §2.6's bright line — an `objective` may inform work but never spawn it. Without it, `objective` becomes a backdoor Intent producing work with no approved plan behind it.

### On immutable plans — the honest cost

If node 7 of 12 needs to change, you version the whole plan. That feels heavy, and it is: plan v2, v3, v4 on a churning task is real noise.

I still recommend it. The alternative is a mutable shared DAG, and a mutable DAG means the graph that ran is not the graph you can inspect — which destroys replay, makes concurrent modification a correctness problem, and turns "why did this run?" into archaeology. Plan versions are cheap to create and their lineage is explicit. Take the noise.

---

## 9. Kernel validation before execution

Fully deterministic. No model call. Runs **before any token is spent**, which is what makes it worth doing thoroughly.

```
1. STRUCTURAL
   · schema-valid WorkUnit; all ids resolve; instance_id consistent throughout

2. GRAPH
   · every depends_on exists, same plan, same instance
   · whole-plan DAG is acyclic
   · artifact-edge predecessors are `accepted`; ordering-edge predecessors terminal
   · derived conflict edges computed; no concurrent unit holds an overlapping scope

3. TYPE
   · every input artifact's type ∈ role.consumes
   · expected_output == role.produces
   · every input's content_hash matches the stored artifact  ← catches config drift
   · every requested input segment is `public`, or `restricted` and explicitly listed
   · no input requests a `private` segment            ← hard reject, always

4. CRITERIA                                            ← the cheapest high-value checks
   · acceptance_criteria non-empty
   · every criterion declares a class
   · EVERY criterion names a resolvable, active gate_ref     [B1, B9]
   · gate.criterion_class == criterion.class for every criterion
   · gate.applies_to includes the unit's expected_output type
   · every segment in gate.requires_segments is visible for that type
   · NO gate requests a `private` segment                    ← hard reject
   · AT LEAST ONE criterion is C0 or C1                ← §3 rule 4
   · every referenced constraint_id exists in its source artifact

5. CONFIG
   · role is `active`; every pinned version resolves and is not `retired`
   · ResolvedExecutionSpec recomputes to the stored hash

6. CAPABILITY
   · effective_capabilities ⊆ role's CapabilityProfile maximum
   · effective_capabilities ⊆ instance policy
   · no capability appears in any layer's denies

7. BUDGET
   · effective_budget > 0 on every axis
   · plan's remaining aggregate budget ≥ this unit's ceiling
   · instance concurrent-spend ceiling not already breached

8. GOVERNANCE
   · every blocking pre_dispatch approval present, unexpired,
     and bound to THIS spec hash                        ← not to an earlier version
```

**Validation failure means the unit never runs.** `status: invalid`, escalate to a human with the specific failed check. There is no partial execution and no "run it and see."

**Why this list is long on purpose.** Every check here is microseconds and catches a failure that would otherwise cost dollars, minutes, and a polluted event log. Validation is the cheapest place in the entire system to be strict, and strictness anywhere else is more expensive.

---

## 10. Artifacts as inputs to downstream WorkUnits

Consumption is explicit, pinned, and segment-scoped:

```yaml
inputs:
  - artifact_id:  "ad_014"
    content_hash: "sha256:9f3c…"
    as:           "governing_decision"
    segments:     ["decision", "constraints", "affected_paths"]
      # NOT "rationale" (restricted, not requested)
      # NOT "reasoning_trace" (private, unrequestable)
```

**Binding chain:** the ContextRecipe's layer selector addresses the *local name* (`governing_decision.constraints`), not a global artifact id. This is what makes recipes reusable across units — the recipe describes a shape, the unit supplies the binding.

**Rules:**

1. Only `accepted` artifacts may be consumed. Draft, rejected, and abandoned are unconsumable.
2. Consumption is **by content hash**. If the artifact were superseded between planning and dispatch, the hash mismatch fails validation — the downstream unit does not silently run against new content nobody approved.
3. A unit may only address segments it lists, and may only list segments its Role's recipe declares an interest in. Intersection, not union.
4. **Requesting a `private` segment is a hard validation failure**, not a silent omission. It should be loud, because it means someone wrote a recipe or a plan that misunderstands the independence model.
5. `inputs_hash` on the produced artifact covers the entire pinned input set, closing provenance transitively back to the human intent.

---

## 11. Failure, retry, and the `FailureRecord`

Question 11 — how structured evidence reaches a retry without the previous attempt's reasoning — is the one I consider most important in this document after §5, and it has the same answer: **enforce by type, not by filter.**

### The `FailureRecord` is a whitelist schema

```yaml
FailureRecord:
  class:        FailureClass
  detected_by:  gate_ref | kernel | human      # NEVER the attempt itself

  failed_criteria: [criterion_id]
  violated_constraints: [{source_artifact, constraint_id}]

  gate_results:                       # verdicts of `fail` only; see gate_errors
    - gate_ref, verdict, location, output_excerpt

  gate_errors:                        # ★ [B2] DISTINCT from gate_results
    - gate_ref, error_class, output_excerpt, retry_ordinal
    # A gate returning `error` is an INFRASTRUCTURE fault, not an artifact
    # defect. It must NOT appear in gate_results, must NOT consume an attempt,
    # and must NOT be classified as a work failure. If a flaky runner registered
    # as `fail`, infrastructure noise would burn the unit's three attempts and
    # escalate a perfectly good diff — and you would spend a week tuning code
    # generation when the problem is the gate runner.

  observed_vs_expected:
    - location, expected, observed

  reproduction:
    command, exit_code, output_excerpt

  diff_summary:                       # SUMMARY, never the narrative
    files_touched, insertions, deletions

  external_findings:                  # from a DIFFERENT role at a boundary
    - source_role_ref, finding_id, claim, evidence, location, suggested_direction
```

**There is no field in this schema capable of holding the failed attempt's narrative.** No `notes`, no `hypothesis`, no `what_i_tried`, no `summary`. The failed attempt's reasoning lives in `Attempt.raw_trace_ref`, which is `private` and unaddressable. The retry structurally cannot receive it — not because a filter removed it, but because no channel exists to carry it.

### The provenance rule ★

The distinction that makes `external_findings` legitimate while the attempt's own narrative is not:

> **Evidence produced by a *different* role at a verification boundary is admissible.
> The failed attempt's own account of itself is not.**

A verifier's `suggested_direction: "key the bucket before the account lookup"` is an independent observation, made by a role that could not write code, against a spec it held independently. That is signal.

The implementer's own `"I keyed it after the lookup because the fixture expected that ordering"` is the reasoning that *produced* the defect, expressed with the fluency of a model that believed it. Feeding it into the retry anchors attempt 2 on a known-bad hypothesis and makes it likelier, not less likely, to repeat. Fluent wrong reasoning is more dangerous on the second pass than on the first, because it now arrives pre-endorsed by history.

### Retry semantics

```
Attempt N fails
  │
  ├─ kernel classifies the failure (from gate results, never self-reported)
  ├─ FailureRecord written to Attempt N  (whitelist schema)
  │
  ├─ consult on_failure[class] from the ResolvedExecutionSpec:
  │
  │   retry_with_evidence ─► attempts_remaining > 0?
  │                           yes ─► Attempt N+1, SAME spec hash,
  │                                  recipe layer `prior_attempt_evidence`
  │                                  bound to Attempt N's FailureRecord ONLY
  │                           no  ─► exhausted ─► escalate
  │
  │   replan             ─► escalate to the plan owner; the contract is suspect,
  │                          not the execution. Produces a NEW WorkUnit under
  │                          plan v(n+1). The current unit closes as `rejected`.
  │
  │   escalate_human     ─► Escalation object with an answerable question (§13)
  │
  └─ no_progress detected ─► always escalate, never retry
```

### Verdicts that are not failures  [B2, B3]

Two gate verdicts never enter this flow at all:

| Verdict | Consumes an attempt? | Route | Why |
|---|---|---|---|
| `indeterminate` | **No** | **Escalate. Never retry blindly** | The gate ran and could not decide — flake beyond quorum, or an ambiguous spec. A retry re-rolls the same dice. If the ambiguity is in the *specification*, escalation is the only destination that can fix it |
| `error` | **No** | Retry the **gate** with backoff; escalate if persistent | Infrastructure fault. Recorded in `gate_errors[]`, never in a `FailureRecord`, and never charged to the unit |

**Neither may be silently coerced to `fail` or `pass`.** A gate that cannot decide must have somewhere honest to go, or it will choose `pass` — the path of least resistance and no immediate visible cost.

### No-progress detection

Independent of the failure class. The kernel hashes `(failed_criteria, gate_verdicts, diff_summary)` per attempt. **Two consecutive identical hashes means the retry loop is not learning, and a third attempt will not either.** Escalate immediately.

Guidance from the current design: **`max_attempts: 3` is the right default, and the third attempt should almost always be a `replan` rather than a retry.** Two identical-shaped failures is strong evidence that the specification is wrong, not the execution — and a third execution attempt against a wrong spec is money spent to reconfirm it.

---

## 12. Human approval

```yaml
Approval:
  id:          ApprovalId
  subject:
    kind:      plan | work_unit_spec | artifact | budget_increase | merge
    ref:       Id
    content_hash: Hash                 # BINDS TO EXACT CONTENT
  decision:    approve | reject | approve_with_conditions
  conditions:  [Criterion]?            # typed, and added to the unit's criteria

  quorum:      QuorumSpec              # ★ [C3]  "N of M"
  approvers:   [HumanPrincipal]        # the named set, size M. Never a role.
  signatures:                          # collected so far
    - { approver: HumanPrincipal, decided_at: timestamp,
        content_hash: Hash, rationale: string? }

  blocking:    bool                    # ★ [D4] false for memory commits
  decided_at:  timestamp?              # set when quorum is met
  scope:
    reuse:     one_time | until_timestamp | for_plan
    expires_at: timestamp
```

Single-approver is the degenerate `1 of 1` case, so nothing about the common path changes shape.

### Invariants

1. **Approval binds to a content hash.** Any change to the subject voids it. There is no approval "in spirit" and no approval of a moving target.
2. **`one_time` is the default scope.** Broader scopes must be explicitly chosen and must expire. An approval without an expiry is a permanent unreviewed grant.
3. **Only a human principal may create an `Approval`.** ★ No role, no kernel path, no automation, under any configuration. This is the single forgery that would invalidate every other guarantee in the system, and it deserves to be an invariant rather than a policy.
4. **A missing or expired approval is a *validation* failure, not a runtime one.** The unit does not start. It never becomes a decision made under time pressure with work already in flight.
5. **Approvals are artifacts in the log** — attributable, replayable, and auditable after the fact.
6. **`approve_with_conditions` produces typed criteria**, appended to the unit's acceptance criteria. A condition that is not a checkable criterion is a comment, and comments do not gate. A condition must therefore bind to a gate like any other criterion.
7. **Under quorum, all signatures bind the same content hash** [C3]. Any change to the subject voids **every** signature collected so far — **no partial carry-forward**. Approval of a moving target is not approval, and this is the case where it would be most tempting.
8. **A pending quorum approval consumes attention from every named approver**, not merely the eventual signers [C3 × C1]. A `2 of 3` sits on all three budgets until resolved. A regulated instance with several quorum gates can exhaust three principals with a handful of changes.

### Non-blocking approvals  [D4]

`blocking: false` marks an approval whose absence stalls nothing. **Memory commits are the only such case at MVP** (Note 05 §6), and they are excluded from the attention-budget pause calculation.

Three reasons, in order of weight: advisory input must not throttle authoritative work — an instance with zero memory produces correct, fully governed output, so letting an unreviewed memory proposal pause an implementation unit would invert the system's value ordering. It would create rubber-stamping pressure, because memory proposals are high-volume and low-individual-stakes, exactly the traffic that trains a human to approve without reading — and that reflex does not stay confined to memory. And the failure mode of *not* approving is benign: the proposal simply never becomes Memory, so there is no pressure to resolve and no mechanism should create one.

Memory approvals therefore have **no SLA**. A proposal may sit indefinitely; that is correct behaviour, not a queue to drain.

### What requires approval at MVP

| Subject | Why |
|---|---|
| The plan, before any node runs | The single highest-leverage human gate. Everything downstream inherits its decomposition and its criteria. |
| Every `ArchitectureDecision` | Its `constraints[]` bind every descendant unit. A wrong constraint is verified-as-correct forever. |
| Any merge to a shared branch | Irreversibility boundary. |
| Any budget increase | Otherwise `fail_closed` is decorative. |
| Any `Role` / config publication | The system does not approve changes to its own governance. |
| Any C3 criterion | By definition. |

---

## 13. Cancellation, timeout, exhaustion, escalation

Four distinct events. Collapsing them into "it stopped" destroys the ability to tell a system problem from a spec problem from a cost problem.

| Event | Trigger | Kernel action | Artifact state |
|---|---|---|---|
| **Cancellation** | Human, or parent plan failure | Cooperative signal → grace period → hard kill. Workspace preserved for inspection, never merged. | `abandoned` |
| **Timeout** | `wall_clock_s` exceeded | Same mechanics; distinct failure class | `abandoned` |
| **Budget exhaustion** | Any budget axis hit | Immediate stop. Consumption recorded. `fail_closed` — no auto-extension, ever. | `abandoned` |
| **Escalation** | `on_failure` policy, or `no_progress`, or exhaustion | Unit → `escalated`, descendants → `blocked`, `Escalation` object raised | unchanged |

Partial output from any of the first three is `abandoned`, **never `draft`** — because `draft` implies "not finished yet" and invites consumption, whereas `abandoned` is terminal and unconsumable.

### Escalation is an object, not a notification

```yaml
Escalation:
  id, work_unit_id, instance_id
  class:      FailureClass
  question:   string                   # MANDATORY, SPECIFIC, ANSWERABLE
  evidence:   [Ref]                    # failure records, gate results, manifests
  options:                             # where enumerable
    - option, consequence, cost_estimate
  blocking:   bool
  raised_at, resolved_at
  resolution: { decision, by, rationale }
```

**The `question` field is mandatory and the kernel rejects an escalation without one.** ★

An escalation that says *"wu_002 failed three times, here is the log"* moves work to the human without reducing it. An escalation that says *"Constraint c4 requires identical responses for existing and non-existent accounts, but the existing test fixture asserts different response times. Should the fixture change, or should c4 be relaxed to cover body-and-status only?"* — that is a decision a human can make in fifteen seconds.

Forcing the question into the schema forces the system to do the work of *framing* the decision, which is most of the work. It is also a genuine quality signal: a unit that cannot produce a specific question usually failed for a reason nobody understands yet, and that is itself worth surfacing.

### Human attention is a budgeted resource ★

The failure mode nobody designs for: **the human gate degrades under load.** Twelve escalations in an hour and the thirteenth gets approved without reading. A rubber-stamped gate is *worse than no gate*, because it produces the appearance of oversight and the log records a human decision that never happened.

Therefore, treat attention as an exhaustible budget with its own limits:

```yaml
InstanceAttentionPolicy:
  max_open_escalations:        int    # exceeded ⇒ PAUSE new dispatch
  max_escalations_per_hour:    int    # exceeded ⇒ throttle, batch, and alert
  max_pending_approvals:       int
  batch_window:                Duration   # group related escalations
  auto_pause_on_breach:        bool       # default true
```

When the instance breaches, **it stops dispatching new work rather than continuing to generate decisions nobody can absorb.** A system that outruns its own oversight has not become more autonomous; it has become unsupervised, and the log will not show the difference.

I would rate this as one of the two or three most important operational properties in the whole design, and it is the one most likely to be omitted because it looks like a nice-to-have.

---

## 14. Replayability

Note 01 replaced determinism with replayability. Here is the precise content of that promise — including its limits, stated honestly.

### Three distinct modes

| Mode | Question | Deterministic? | Guaranteed? |
|---|---|---|---|
| **1. Audit replay** | What exactly did the system see and decide? | Yes — no model call | **Always. Non-negotiable.** |
| **2. Context replay** | Does recompiling from the same sources reproduce the same manifest hash? | Yes — compiler is a pure function | **Yes**, given intact sources |
| **3. Execution replay** | What does the model do given identical context now? | **No** | Never guaranteed |

Mode 1 is what you use to investigate a failure. Mode 2 is how you regression-test the Context Compiler — the highest-leverage component and, conveniently, a pure function. Mode 3 is for **A/B evaluation** (new model, new prompt, new recipe against a fixed historical context), not for verifying the past. Conflating mode 3 with the others is how a system ends up claiming reproducibility it cannot deliver.

### The capture set

For mode 1 to always work, every attempt must persist:

```
WorkUnit contract + ResolvedExecutionSpec (full flattened bundle + hash)
ContextManifest   (layer hashes, source versions, transforms, truncations, assembled hash)
Rendered prompt hash
Model actually served + sampling params
Capability token minted
Every tool invocation: seq, args hash, scope decision, result hash
Every gate result + evidence
Produced artifact content hash + all segment hashes
Approvals with their subject hashes
FailureRecord, if any
```

### The constraint this places on recipes ★

> **Every context source must be content-addressable or version-pinned.
> A source that cannot be is not admissible as a recipe layer.**

Repository at a commit SHA: fine. Artifacts: immutable by construction. Config: versioned, retired-not-deleted. A live external API with no version pin: **not admissible**, because any layer drawing from it makes mode 1 and mode 2 permanently broken for every attempt that used it.

**Memory is a context source, so this rule applies to it and is not optional** [D5]. `MemoryRecord`s are therefore **immutable, versioned, and content-addressable**, superseded rather than edited, and **never deleted** — `expired` and `retracted` are statuses (Note 05 §3, §12). This is *forced* by the rule above, not chosen: mutable Memory would break replay modes 1 and 2 for every attempt whose context included it, and deleting a record that turned out to be wrong would destroy the evidence needed to understand what it caused.

The manifest must record the memory layer's **candidate, included, and dropped** sets with reasons (Note 05 §13) — recording only what was included is insufficient, because a dropped record is often the explanation.

This rules out a category of layer that will seem obviously useful — "current production metrics," "today's error rate," "live competitor pricing." The fix is not to forbid the data but to **snapshot it into an immutable artifact first**, and have the recipe pull from the snapshot. The snapshot is content-addressable; the API is not.

### Retention

- Artifacts, manifests, specs, approvals, failure records: **retained for the instance's audit horizon.**
- Raw reasoning traces (`private`): retained on a **shorter** horizon — they are the largest by volume and the least reusable. Their absence degrades human debugging but does not break mode 1 or 2, since neither replays them into anything.
- Config versions: **never deleted**, only `retired`. Deleting a version makes every trace that pinned it unreplayable, which is the one irreversible way to lose the property.

---

## 15. What must NOT belong in `WorkUnit` or `Artifact`

### Not in `WorkUnit`

| Field | Belongs | Failure if included |
|---|---|---|
| Prompt text | `ResolvedExecutionSpec` → `prompt_ref` | Untracked prompt variation per unit; nothing is comparable, nothing is testable |
| `assigned_agent` / worker identity | Nowhere | There is no actor. A Role is config; a unit references `role@version`, not a "who" |
| Mutable `acceptance_criteria` | Nowhere | Destroys the core invariant. A unit that can soften its own criteria always eventually passes |
| `notes` / `comments` free-text field | Nowhere | Becomes an unaudited side channel into context, bypassing the manifest entirely |
| `retry_count` | Derived from `attempts[]` | Duplicated state that drifts from the attempt record |
| Accumulated conversation history | `ContextManifest` per attempt | A unit carrying its own history bypasses the Context Compiler — unbudgeted, unhashed, invisible to replay |
| `priority` as a free field | Plan-level, policy-derived | Everything becomes P0 within a week. Priority is a scheduling policy, not a unit property |
| References to another unit's internals | `inputs` (artifact refs only) | Couples units the DAG believes are independent |
| Cross-instance references | Nowhere | Structural violation of the isolation boundary |
| `estimated_effort` / velocity fields | Nowhere | Human-org metrics with no mechanical meaning here; invites planning theatre |

### Not in `Artifact`

| Field | Belongs | Failure if included |
|---|---|---|
| Mutable content | Nowhere — supersede instead | Breaks the provenance chain and every downstream `content_hash` pin |
| Self-assessed verdict or confidence | Nowhere — `private` at most | Reads as evidence downstream; model confidence is poorly calibrated and highly persuasive |
| "Done" / success claims | Gate results | Note 01: `self_report_accepted: false`. This is where that is enforced structurally |
| Unclassified free text | A typed, visibility-classed segment | Any addressable text is a contamination channel. Every segment must carry a visibility class |
| Secrets, tokens, credentials | Nowhere | Redaction is a production-time transform; a gate should assert absence before the artifact is created |
| Absolute host paths, PIDs, temp dirs | Nowhere | Unreconstructible at replay; breaks mode 1 and 2 |
| Implicit dependencies not in `inputs_hash` | `inputs` | A hidden input is an unreplayable artifact wearing a valid hash |
| Direct references to other artifacts' `private` segments | Nowhere | Would launder private content into a public one |

### The general rule

> **`WorkUnit` holds only what must be true. `Artifact` holds only what was produced, in typed and visibility-classed segments. Everything about *how it went* lives on `Attempt`, and everything about *why the model thought so* is `private`.**

---

## 16. Complete worked example

Continuing the password-reset rate-limiting case from Note 01 §15, now with full records including the failed attempt and retry.

### Stage 0 — Intent

```yaml
Intent:
  id: int_0091
  raised_by: human:founder
  statement: "Password reset is being abused. Add rate limiting."
  raised_at: 2026-08-12T09:14:00Z
```

Kernel dispatches a planning unit (`role: planner@1.0.0`, `emits_plan: true`) producing:

```yaml
TaskPlan:
  id: plan_0091_v1
  intent_ref: int_0091
  nodes:
    - { node: n1, class: contract_change,  role: architect@1.2.0   }
    - { node: n2, class: bounded_change,   role: implementer@2.0.1, depends_on: [n1:artifact] }
    # NO verification node.  [B10]  Verification is not a plan concept: it attaches
    # to criteria, and the kernel derives the work (Note 03 §1). A plan naming
    # verifier@1.1.0 would fail validation, since that Role appears as a gate's
    # execution.role_ref. A plan that forgets to verify is no longer expressible.
  approvals_required: [{ kind: pre_dispatch, subject: plan, blocking: true }]
```

**Human approves plan_0091_v1** (bound to its content hash). Only now does anything run.

---

### Stage A — Architecture

```yaml
WorkUnit:
  id: wu_101
  class: contract_change
  objective: "Determine the approach for rate limiting the password-reset flow."
  inputs: []
  expected_output: ArchitectureDecision
  acceptance_criteria:
    - { id: a1, class: C0, statement: "Emits ≥1 machine-checkable constraint.",
        check: { gate_ref: "gate://constraints.checkable" }, blocking: true }
    - { id: a2, class: C0, statement: "Names affected paths.",
        check: { gate_ref: "gate://artifact.schema_valid" }, blocking: true }
    - { id: a3, class: C3, statement: "Approach is acceptable to the founder.",
        check: { gate_ref: "gate://approval.architecture@1.0.0" }, blocking: true }
        # C3 binds a gate like every other class [B9]; the gate names the approver
  execution_spec: { hash: "sha256:a41f…", role_ref: "architect@1.2.0", … }
  budget: { cost_ceiling: $2.00, wall_clock_s: 300, max_attempts: 2 }
  approvals_required: [{ kind: pre_merge, subject: artifact, blocking: true }]
```

Note a1 and a2 are C0 — the "at least one C0/C1" rule is satisfied even though the substance of the decision is C3. This is the correct shape for an architecture unit: mechanical checks on the *form* of the output, human judgement on its *content*.

**Attempt 1** — context compiled via `architecture.v1` at 41,200 tokens; `model_served: frontier candidate 1`; cost $1.34. Produces:

```yaml
Artifact:
  id: ad_014
  type: ArchitectureDecision
  schema_ref: "schema://architecture_decision/1.0.0"
  segments:
    - { name: decision,      visibility: public,     content: "Apply existing token-bucket
          middleware at the route layer, keyed on (email_hash, source_ip). Reuse Redis store." }
    - { name: constraints,   visibility: public,     content: [
          { id: c1, statement: "No new runtime dependency." },
          { id: c2, statement: "Reuse rateLimiter from src/middleware/rateLimit.ts." },
          { id: c3, statement: "No change to the public API contract of POST /auth/password-reset." },
          { id: c4, statement: "Response on limit must not reveal whether the account exists." },
          { id: c5, statement: "Limit values config-driven, not literals." } ] }
    - { name: affected_paths,visibility: public,     content: ["src/routes/auth/passwordReset.ts",
                                                               "src/config/limits.ts"] }
    - { name: out_of_scope,  visibility: public,     content: ["global API limiting","CAPTCHA","lockout"] }
    - { name: rationale,     visibility: restricted, content: "…" }
    - { name: alternatives_rejected, visibility: restricted, content: […] }
    - { name: reasoning_trace, visibility: private,  content_ref: trace_88a1 }
  status: accepted
  approvals: [appr_0031]     # human:founder, bound to content_hash
```

---

### Stage B — Implementation, attempt 1 (fails)

```yaml
WorkUnit:
  id: wu_102
  class: bounded_change
  objective: "Implement rate limiting on POST /auth/password-reset per ad_014."
  inputs:
    - { artifact_id: ad_014, content_hash: "sha256:7b2e…", as: "governing_decision",
        segments: ["decision","constraints","affected_paths"] }   # NOT rationale
  expected_output: CodeDiff
  constraints: [{ source_artifact: ad_014, constraint_ids: [c1,c2,c3,c4,c5] }]
  acceptance_criteria:
    - { id: b1, class: C0, statement: "No dependency manifest change.",
        check: { gate_ref: "gate://deps.unchanged" } }
    - { id: b2, class: C0, statement: "Public API schema unchanged.",
        check: { gate_ref: "gate://api.schema_unchanged" } }
    - { id: b3, class: C1, statement: "Build, typecheck, and affected tests pass.",
        check: { gate_ref: "gate://tests.affected_pass" } }
    - { id: b4, class: C1, statement: "4th request within 60s returns 429.",
        check: { gate_ref: "gate://runtime.smoke" } }
    # [B6] c4 was MIS-CLASSIFIED as C2 here. It is an `equivalence` constraint
    # and compiles to a C1 differential test (Note 03 §12, §18): name the
    # observables and the check becomes mechanical, cheap, and permanent.
    - { id: b5, class: C1, statement: "Responses are indistinguishable for existing vs
                                        non-existent accounts, including under limit.",
        check: { gate_ref: "gate://differential.response_equivalence@1.0.0",
                 parameters: { observables: [status_code, response_body,
                                             headers.retry_after, rate_limit_applied],
                               tolerance: { timing_ms: 50 }, repetitions: 5 } },
        derived_from: "ad_014#c4" }
    # Caught in ~6s at zero marginal cost, before the expensive stage runs at all
    # — versus ~4 min and ~$2.80 as a model judgement. A C1 check is an asset;
    # a C2 judgement is a consumable, re-purchased on every future change.
  depends_on: [{ unit_id: wu_101, kind: artifact }]
  affected_paths: ["src/routes/auth/**", "src/config/limits.ts"]
  budget: { cost_ceiling: $6.00, files_touched: 4, max_attempts: 3 }
```

**Attempt 1** — `implementation.v1` compiles 68,400 tokens. Capability token: fs read/write scoped to the ephemeral worktree, `shell.exec` in the worktree, `git.commit`; **`network.egress: none`**, no secrets, no push. Cost $3.10. Produces `diff_0212`.

Gates run in cost order: `deps.unchanged` ✓ (b1) · `api.schema_unchanged` ✓ (b2) · `tests.affected_pass` ✓ (b3, 7 new tests) · `runtime.smoke` ✓ (b4) · then **b5's C1 differential gate fails** — see Stage C.

---

### Stage C — Gate execution (not a plan node)  [B5, B10]

**`wu_103` is not a free-standing verification unit.** It is the *execution* of a model-judged gate, dispatched by the kernel because a criterion binds one — never because a plan scheduled it. Its `class` is not `verification`; that class does not exist (§17.1's table has four members, and `verification` is not among them).

In the corrected trace, b5's `differential.response_equivalence` gate (C1, stage 3) fails in ~6 seconds and **short-circuits stage 4 entirely** — so the expensive model gate below never runs on attempt 1. It is shown here as it would run on a diff that passed stage 3.

```yaml
GateExecutionWorkUnit:                 # materialised by the kernel, not by a plan
  id: wu_103
  gate_ref: "gate://review.independent@1.1.0"
  executing_role: verifier@1.1.0       # from the GATE's execution.role_ref
  decides: [b5_followup]
  budget: from the parent unit's `verification` allocation  [B7]
  objective: "Verify diff_0212 against wu_102's criteria and ad_014's constraints."
  inputs:
    - { artifact_id: diff_0212, as: "change",
        segments: ["diff","files_touched","gate_evidence","test_provenance"] }
        # NOT implementation_notes (restricted, not requested)
        # NOT reasoning_trace / self_assessment (private, unrequestable)
    - { artifact_id: ad_014, as: "governing_decision", segments: ["constraints"] }
    - { artifact_id: spec_wu_102, as: "spec", segments: ["objective","acceptance_criteria"] }
```

`verifier@1.1.0` runs a **different model family** than `implementer@2.0.1`, with **no write capability of any kind**. Produces:

```yaml
Artifact:
  id: vr_0308
  type: VerificationReport
  segments:
    - name: verdict          visibility: public   content: changes_requested
    - name: constraint_checks visibility: public  content:
        { c1: pass, c2: pass, c3: pass, c4: FAIL, c5: pass }
    - name: findings         visibility: public   content:
        - id: f1
          severity: blocking
          criterion: b5
          constraint: "ad_014#c4"
          location: "src/routes/auth/passwordReset.ts:58"
          claim: "Limited responses differ by account existence."
          evidence: "Existing account → 429 after 3 attempts. Unknown account → 200,
                     generic body, unlimited. The rate limit itself is the enumeration
                     oracle. Reproduced: [test output]."
          suggested_direction: "Key the bucket before the account lookup, not after."
    - name: test_assessment  visibility: public   content:
        "7 implementer-authored tests pass; none asserts response equivalence across
         existing/non-existent accounts — precisely the property c4 requires."
    - name: reasoning_trace  visibility: private  content_ref: trace_88c7
```

---

### Stage D — Retry with structured evidence only

Kernel classifies `verification_failed` → `retry_with_evidence`. Attempt 2 on **wu_102** — the WorkUnit contract is untouched; only a new Attempt is created.

```yaml
Attempt:
  id: att_0102_2
  work_unit_id: wu_102
  ordinal: 2
  execution_spec_hash: "sha256:c93d…"      # IDENTICAL to attempt 1
```

The `prior_attempt_evidence` recipe layer binds to:

```yaml
FailureRecord:                              # from att_0102_1
  class: verification_failed
  detected_by: "verifier@1.1.0 / vr_0308"
  failed_criteria: [b5]
  violated_constraints: [{ source_artifact: ad_014, constraint_id: c4 }]
  external_findings:
    - source_role_ref: "verifier@1.1.0"
      finding_id: f1
      claim: "Limited responses differ by account existence."
      evidence: "…"
      location: "src/routes/auth/passwordReset.ts:58"
      suggested_direction: "Key the bucket before the account lookup, not after."
  diff_summary: { files_touched: 3, insertions: 91, deletions: 4 }
```

**What attempt 2 does not receive:** `att_0102_1.raw_trace_ref` (private), the `implementation_notes` segment of diff_0212 (restricted, not requested), and any self-assessment. There is no field in `FailureRecord` that could carry them.

**No-progress check:** hash of `(failed_criteria=[b5], gate_verdicts, diff_summary)` differs from any prior attempt. Proceed.

Attempt 2 keys the bucket pre-lookup and adds the equivalence test. Gates b1–b4 ✓, and b5's C1 differential gate now passes 3/3. **Only then** does stage 4 run: `review.independent` executes as `wu_104` under `verifier@1.1.0` → `verdict: pass`, with one advisory finding on naming.

---

### Stage E — Close

```yaml
Approval:
  id: appr_0044
  subject: { kind: merge, ref: diff_0219, content_hash: "sha256:e07a…" }
  decision: approve
  approver: human:founder
  scope: { reuse: one_time }
```

**Total:** 2 model calls for architecture and planning, 2 implementation attempts, 2 verifications, 9 deterministic gate runs, ~$11.40, 2 human decisions (plan, merge) plus 1 architecture approval. Fully replayable in mode 1 and mode 2 from the event log.

**What actually caught the defect**, restated because it matters: constraint `c4` was written to be *checkable*; criterion `b5` was correctly classified `C2` rather than optimistically as `C1`; the verifier was blind to the implementer's account of its own work; and the verifier had no capability to quietly patch what it found. None of that is hierarchy. All of it is typed contracts and enforced boundaries.

---

## 17. Challenges to the current architecture

You asked me to challenge it. Six, ordered by how much they should change your plans.

### 17.1 The three-stage pipeline is wrong for most work ★ — this is a real gap

`architecture → implementation → verification` is correct for changes that touch a contract. It is pure ceremony for a dependency bump, a typo, or a bug fix that already has a failing test. Running an architecture unit on a typo produces a ceremonial `ArchitectureDecision` that nobody needs, costs a frontier-model call, and — worse — trains you to treat architecture artifacts as noise.

**Proposal: `WorkUnitClass` determines the mandatory pipeline.** I have already used this in the schema (`class:`) because I think it is necessary, not optional:

| Class | Pipeline | Verifier | When |
|---|---|---|---|
| `mechanical_change` | implement → deterministic gates | None (C0/C1 only) | Dep bumps, formatting, generated code, renames |
| `bounded_change` | implement → gates → model verify | Yes | Behaviour change inside existing contracts |
| `contract_change` | architect → implement → gates → model verify | Yes | Public interface, schema, security, auth |
| `investigation` | investigate → report | None | Diagnosis; produces findings, not diffs |

With a validation rule that closes the obvious hole: **a `mechanical_change` whose diff touches a public interface, a security-relevant path, or a schema fails validation and is promoted to `contract_change`.** The class is a claim the kernel checks against the actual diff — not a self-assessment the executor gets to make.

Without this, the economics are bad enough to sink adoption: ~6–10 model calls per change is defensible at high value-per-change and absurd for trivia. **Instrument cost-per-accepted-change per class from day one.**

### 17.2 Acceptance criteria authorship is the deepest unsolved risk ★★

Everything downstream is verified against criteria written by the planner. If the criteria are wrong, the pipeline verifies the wrong thing perfectly, every gate passes, and the system reports success with full evidence and complete provenance. **Nothing currently checks criteria quality.**

This is the ceiling on the whole system: *its output quality is bounded by its specification quality, and specification is precisely what models are worst at.* Verification, gates, constraints, and segmentation all protect against bad *execution*. None protects against a well-executed wrong specification.

Partial mitigations, in descending order of value:

1. **The human plan-approval gate** — this is why it is the highest-leverage approval in the design, and why it must not be batched away under load (§13).
2. **The §3 rule 4 check** — at least one C0/C1 criterion. Crude, cheap, and catches the "all vibes" spec.
3. **Criteria-quality gate** — do the criteria's nouns appear in the objective? Is any criterion trivially satisfiable by an empty diff? Weak but non-zero.
4. **Post-hoc measurement** — track how often accepted units are later reworked. A high rework rate against passing criteria *is* the signal that criteria authorship is failing, and it is the only honest measure you will get.

I do not have a strong solution here and I do not think one exists yet. I would rather name it as the load-bearing risk than paper over it.

### 17.3 Who verifies the verifier?

The verifier is a single point of judgement, and nothing checks it. Rubber-stamp drift — a verifier that gradually passes everything — is **invisible if you only inspect failures.**

Concrete mitigation: **sample N% of `verdict: pass` units for human review**, not just failures, and track verifier-vs-human disagreement as a first-class system health metric. A rising disagreement rate is your only early warning. This should be in the MVP instrumentation, not deferred, because the baseline is only meaningful if you have it from the start. Registered as **Appendix A measure 4** — the only measure in that register requiring work beyond a projection, and the only instrument this problem has.

### Partial resolution — deterministic gates only  [B8]

**For C0 and C1 gates this now has a clean answer: `must_fail` fixtures at registration** (Note 03 §8). A gate that has never rejected anything is indistinguishable from one that passes everything — a stub, a moved path, a silently short-circuiting predicate. All fail *open*, and the only symptom is an excellent pass rate. Requiring at least one known-bad fixture the gate **must** reject converts that into a registration-time and every-version test. The same requirement now covers predicates (Note 08 §10) and tools (E4).

**It does not extend to C2 model-judged gates.** A fixture the verifier rejects this week may pass next week after a model update, and enforcing fixture stability there would make every model upgrade a false alarm. What remains available, all weaker: sampled human audit of passes (above); shadow-running a new model version against historical C2 executions and diffing verdicts before promotion; and — the strongest, indirect — **preferring demotion**, since every constraint moved from C2 to C1 by the form vocabulary (Note 03 §12) is one fewer place this problem exists. The judgement layer still has no mechanical self-check, and the honest mitigation is to depend on it less.

### 17.4 Immutable plans will thrash

I mandated it in §8 and I stand behind it, but be honest about the cost: a churning task produces plan v2, v3, v4, and the plan history becomes noisy. The alternative — a mutable DAG — makes replay impossible and turns concurrent modification into a correctness problem. Take the noise; it is the cheaper failure.

### 17.5 The segmentation boundary leaks through code comments

Covered in §5. Worth repeating here because it is the sharpest limit on the independence property: **a `CodeDiff`'s diff segment is `public` and code contains comments**, so an implementer can smuggle its rationale — including a rationalisation of the very defect under review — into content the verifier must read. Unfixable by schema. Mitigated only by prompt discipline and an advisory gate. Any claim that verification is structurally independent is true of everything *except* the diff body, and that exception should be stated whenever the claim is made.

### 17.6 `Attempt` is where the next bloat will happen

Note 01's `Role` grew because it was the only object that existed. `Attempt` is now the object that touches everything — config, context, tools, cost, failure, trace — and it will attract fields for the same reason. Watch for: derived metrics that belong in a projection, retry logic that belongs in the kernel, and anything resembling a `notes` field. Apply the same test: **if a field cannot name a specific failure it prevents, and that prevention is not mechanically enforced, it does not belong.**

---

### Amendments to Note 01, if §0 is accepted

**Moved.** Proposed amendments are now tracked in `AMENDMENTS-pending.md` (entries A1–A9), which is the canonical ledger for the remainder of the architecture pass. Nothing is applied until the pass completes; Notes 01 and 02 remain as originally written.

---

## 18. Deferred questions

1. **`SelectorExpr` grammar** — still open from Note 01, now with an added requirement: it must be structurally incapable of addressing a `private` segment.
2. **Gate registry** — how gates are defined, versioned, sandboxed, and how a C0 gate is authored. Blocking for implementation; the criteria taxonomy assumes gates exist.
3. **Instance policy schema** — now carries real weight: permitted roles in plans, capability intersection, gate union, budget minimums, and the attention policy from §13.
4. **Fleet model binding table** — introduced in §0, unspecified.
5. **`TaskPlan` artifact schema** — used throughout, still informal.
6. ~~**Memory stores — the four stores**~~ — **RESOLVED and CORRECTED**, Note 05 [D1]. There are not four stores: three were absorbed elsewhere (repository, `ArchitectureDecision` artifacts, `Attempt` + event log). Memory retains five *kinds*, all human-approved and advisory.
7. **Criteria-quality gate** — §17.2. Probably the most valuable unsolved design problem in the system.
8. **Storage, event log, and the kernel's own architecture** — still deliberately last. Two documents in, the model has not been shaped by a database, which was the point.

---

*End of Design Note 02.*

# AI-Org OS — Design Note 03
## The Gate Registry and the Verification Layer

**Status:** Draft for review
**Scope:** Data model and semantics for verification. No implementation, no storage decisions.
**Depends on:** Note 01 (Role, ContextRecipe), Note 02 (WorkUnit, Artifact, Attempt)
**Amendments:** Raised in `AMENDMENTS-pending.md`. Notes 01 and 02 remain untouched.

Note 02 §3 defined criteria in terms of gates and then assumed gates existed. This note pays that debt. It is the last primitive blocking implementation.

---

## Table of contents

1. [What a Gate is — and the C2 question](#1-what-a-gate-is--and-the-c2-question)
2. [The `Gate` schema](#2-the-gate-schema)
3. [Gate kinds and execution substrates](#3-gate-kinds-and-execution-substrates)
4. [The four-valued verdict](#4-the-four-valued-verdict)
5. [`GateResult`, evidence, and the visibility ceiling](#5-gateresult-evidence-and-the-visibility-ceiling)
6. [Determinism requirements](#6-determinism-requirements)
7. [Flake, quorum, and `indeterminate`](#7-flake-quorum-and-indeterminate)
8. [The registry: authoring, registration, versioning](#8-the-registry-authoring-registration-versioning)
9. [`GateProfile` and monotonic composition](#9-gateprofile-and-monotonic-composition)
10. [Ordering, short-circuit, and evidence batching](#10-ordering-short-circuit-and-evidence-batching)
11. [Binding criteria to gates](#11-binding-criteria-to-gates)
12. [Constraint compilation: the form vocabulary](#12-constraint-compilation-the-form-vocabulary)
13. [Model-judged gates](#13-model-judged-gates)
14. [Human gates](#14-human-gates)
15. [Gate budgets and cost accounting](#15-gate-budgets-and-cost-accounting)
16. [Gate sandboxing and security](#16-gate-sandboxing-and-security)
17. [What must NOT be a Gate](#17-what-must-not-be-a-gate)
18. [Worked example, corrected](#18-worked-example-corrected)
19. [Challenges](#19-challenges)
20. [Deferred questions](#20-deferred-questions)

---

## 1. What a Gate is — and the C2 question

> **A Gate is a versioned, registered predicate over an Artifact and its pinned execution context, producing a typed verdict with evidence. A Gate never mutates its subject.**

### The inconsistency in Note 02

Note 02 had it both ways and I should name that before building on it. Criterion `b5` declared `check.verifier_role`, as if a model judgement were a property of the criterion. But the worked example also dispatched `wu_103`, a free-standing verification WorkUnit. Those are two different mechanisms for one thing, and shipping both would produce two verification code paths that drift.

### Resolution: uniform interface, different substrate

**Everything that decides a criterion is a Gate. What differs is the substrate the kernel uses to execute it.**

| Gate kind | Substrate | Cost | Produces |
|---|---|---|---|
| `deterministic` (C0) | Sandboxed program over the artifact | Compute | `GateResult` |
| `empirical` (C1) | Sandboxed program that *executes* something | Compute + time | `GateResult` |
| `model_judged` (C2) | **A real WorkUnit** dispatched by the kernel | Money + time | `GateResult` + `VerificationReport` artifact |
| `human` (C3) | An `ApprovalRequest` | Attention | `GateResult` + `Approval` artifact |

This is the right shape for one reason: a model-judged check is not a function call. It costs money, needs a compiled context, needs a capability token, can fail, can time out, can exhaust a budget, and must be replayable. Everything in Note 02 that makes a WorkUnit a WorkUnit applies to it. Pretending otherwise would mean rebuilding budgets, manifests, attempts, and failure classification inside the gate runner.

So: criteria bind to gates uniformly (`check.gate_ref`, all classes — ledger B1). The kernel reads the gate's `kind` and routes to the substrate. `wu_103` in Note 02 was the execution of `gate://review.independent`; it was never a free-standing concept (ledger B5).

**Consequence worth stating:** the verifier Role from Notes 01 and 02 does not disappear. It is now *referenced by a gate definition* rather than dispatched by a plan. Plans stop containing verification nodes; verification is attached to criteria, and the kernel derives the work. This removes a whole class of planner error — a plan that forgets to verify something is no longer expressible.

---

## 2. The `Gate` schema

```yaml
Gate:

  # ---- IDENTITY -------------------------------------------------------
  id:            GateId                 # "deps.unchanged", "review.independent"
  version:       SemVer
  name:          string
  description:   string
  owner:         HumanPrincipal         # accountable human. Never a Role.
  status:        draft | active | deprecated | retired

  # ---- APPLICABILITY --------------------------------------------------
  kind:          deterministic | empirical | model_judged | human
  criterion_class: C0 | C1 | C2 | C3     # must agree with `kind`
  applies_to:    [ArtifactType]          # which artifacts this can judge
  requires_segments: [SegmentName]       # what it must read (visibility-checked)
  requires_context:                      # beyond the artifact itself
    - workspace_snapshot                 # e.g. the worktree at post-diff state
    - baseline_artifact                  # e.g. pre-change state
    - constraint_refs
    - runtime_environment
    # ★ [D3] THIS ENUMERATION IS CLOSED AND MAY NEVER INCLUDE A MEMORY SOURCE.
    # It is disjoint by construction from the Context Compiler's source set
    # (Note 05 §7). Gate registration REJECTS any gate declaring a source
    # outside it. A gate reading Memory would put advisory content into the
    # enforcement path — Memory informs, it never constrains — and would
    # launder it onward, since a GateResult feeds FailureRecords and retries.
    # Silence was not a prohibition; this is.

  # ---- BEHAVIOUR ------------------------------------------------------
  parameters:                            # bound at profile/criterion level
    - name, type, default, required
  verdict_semantics:
    pass_means:  string                  # HUMAN-READABLE, mandatory
    fail_means:  string
  produces_evidence: [EvidenceKind]      # what the gate always emits

  # ---- EXECUTION ------------------------------------------------------
  execution:
    substrate:   sandbox | work_unit | approval_request
    role_ref:    RoleRef?                # model_judged only
    approver:    ApproverSpec?           # human only
    entrypoint:  EntrypointRef?          # sandbox only; registered, not inline
    cost_class:  free | cheap | moderate | expensive
    stage:       int                     # coarse ordering band
    timeout_s:   int
    determinism: required | not_required # `required` for C0
    flake_policy:                        # C1 only
      max_runs:  int
      quorum:    string                  # e.g. "3/3" — see §7

  # ---- SAFETY ---------------------------------------------------------
  sandbox:
    network:     none | allowlist        # `none` for every gate at MVP
    filesystem:  PathGlob[]              # read-only unless declared
    may_write:   bool                    # false except to a scratch path
    audit_only:  bool                    # if true, may read `private` segments
                                         # and its evidence is forced `private`

  # ---- QUALITY CONTROL ------------------------------------------------
  fixtures:
    must_pass:   [FixtureRef]            # artifacts this gate MUST accept
    must_fail:   [FixtureRef]            # artifacts this gate MUST reject  ★
    must_error:  [FixtureRef]?           # malformed inputs it must report as `error`
  registration_checks:
    determinism_verified: bool           # C0: same input twice, same evidence hash
    negative_coverage:    bool           # at least one `must_fail` fixture  ★
```

### Field notes

| Field | Why |
|---|---|
| `verdict_semantics.pass_means` **mandatory** | A gate whose pass condition cannot be stated in one sentence is doing more than one thing. This field is a design check disguised as documentation. |
| `requires_segments` | Gates read artifacts, so they are subject to the visibility model (§5). Declaring the need makes the check static. |
| `criterion_class` must agree with `kind` | Prevents the most common misclassification: registering a model-judged check as C1 because it "usually works". |
| `fixtures.must_fail` | ★ The single most important field in this schema. See §8. |
| `audit_only` | The only path to `private` segments, and it forces the evidence private in exchange. See §5. |
| `stage` + `cost_class` | Drives ordering and short-circuit (§10). |

---

## 3. Gate kinds and execution substrates

```
                      criterion.check.gate_ref
                                │
                    kernel reads Gate.kind
                                │
        ┌───────────────┬───────┴────────┬─────────────────┐
        ▼               ▼                ▼                 ▼
  deterministic     empirical      model_judged          human
        │               │                │                 │
   sandbox run     sandbox run      dispatch a         raise an
   pure function   + execution      real WorkUnit      ApprovalRequest
        │               │                │                 │
        │               │          own budget,        blocks; attention
        │               │          manifest,          policy applies
        │               │          capability token,  (Note 02 §13)
        │               │          Attempt record
        ▼               ▼                ▼                 ▼
   GateResult      GateResult      GateResult +      GateResult +
                   (+ flake        VerificationReport  Approval
                    handling)
```

**The kernel — not the gate — owns substrate selection, budget enforcement, and result recording.** A gate declares what it is; it does not decide how it runs. This keeps a single enforcement point for cost, timeout, and sandboxing across all four kinds.

---

## 4. The four-valued verdict

Boolean verdicts are the wrong shape, and the error is expensive.

```
GateVerdict = pass | fail | indeterminate | error
```

| Verdict | Meaning | Consumes an attempt? | Kernel action |
|---|---|---|---|
| `pass` | The predicate holds, with evidence | — | Proceed |
| `fail` | The predicate does not hold, with evidence | **Yes** | `FailureRecord`, apply `on_failure` |
| `indeterminate` | The gate ran but cannot decide (flake, quorum not met, ambiguous spec) | **No** | Escalate. Never retry blindly. |
| `error` | **The gate itself broke** — crash, timeout, missing dependency, sandbox fault | **No** ★ | Retry the *gate*; escalate if persistent. No `FailureRecord`. |

### Why `error` must be distinct from `fail` ★

If a flaky test runner or a transient sandbox fault registers as `fail`, then infrastructure noise burns the unit's three attempts and escalates a perfectly good diff as a failed change. Over a week that produces a system that looks unreliable at generating code when it is actually unreliable at running gates — and you will spend the week tuning the wrong thing.

**A gate error is never the artifact's fault, and it must never appear in a `FailureRecord`** (ledger B2). It goes to `Attempt.gate_errors[]`, is retried at the gate level with backoff, and escalates as an *operations* problem, not a work problem.

### Why `indeterminate` must exist

Without it, a gate that cannot decide is forced to choose. It will choose `pass`, because passing is the path of least resistance and produces no immediate visible cost. `indeterminate` gives it somewhere honest to go, and routes the decision to a human rather than to silence.

`blocking` is orthogonal to the verdict: a blocking gate halts on `fail` or `indeterminate`; an advisory gate records and proceeds. Neither may proceed past `error` — an unrun gate is not an advisory pass.

---

## 5. `GateResult`, evidence, and the visibility ceiling

```yaml
GateResult:
  id, gate_ref, version
  subject:
    artifact_id, content_hash          # exactly what was judged
  decides:  [criterion_id]             # which criteria this result settles
  verdict:  pass | fail | indeterminate | error
  blocking: bool                       # from the composed profile, not the gate
  decided_at, duration_ms, cost

  evidence:
    - kind:     EvidenceKind
      content:  any
      location: Location?              # file:line, endpoint, symbol
      visibility: public | restricted | private     # DERIVED, see below

  determinism_hash: Hash?              # C0 only — over the evidence
  runs:             [RunRecord]?       # C1 only — one per quorum run
  execution_ref:    WorkUnitId?        # C2 — the gate's own execution unit
  approval_ref:     ApprovalId?        # C3
```

### Evidence kinds

| Kind | Example |
|---|---|
| `assertion` | "dependency manifest unchanged: 0 additions" |
| `diff_projection` | The derived API-schema diff, not the raw code diff |
| `command_output` | Test runner output, exit code, excerpt |
| `metric` | `files_touched: 3`, `p99_ms: 180` |
| `location` | `src/routes/auth/passwordReset.ts:58` |
| `finding` | Structured claim + evidence + suggested direction (C2) |
| `reproduction` | Command + expected + observed |

### The visibility ceiling ★

A hole I did not close in Note 02, and it is a real one.

Gates read artifacts. If a gate is permitted to read a `private` segment and then *quotes* it in evidence, that private content lands in a `GateResult` — which is public, flows into `FailureRecord`, and reaches the retry. Segment visibility would be laundered through the verification layer, and the independence property from Note 02 §5 would be defeated by the very mechanism meant to enforce it.

**Rule:**

> **Evidence visibility is the maximum visibility of anything it quotes.**
> A `GateResult` whose evidence quotes a `restricted` segment is itself `restricted`.
> A gate may read `private` segments **only** if `sandbox.audit_only: true`, in which case **all** of its evidence is forced `private` and the gate may decide **no** criterion that feeds a retry.

`audit_only` gates therefore exist for one purpose: human-facing analysis and system health metrics. They can look at everything and can tell nothing to the machine. That is the correct trade, and it is the only safe way to allow private-segment inspection at all.

---

## 6. Determinism requirements

For `kind: deterministic` (C0), `execution.determinism: required` means:

1. Pure function of `(artifact content, pinned baseline, declared parameters)`.
2. **No network.** `sandbox.network: none`, non-negotiable.
3. **No wall-clock or date dependence.** No `now()`, no TTL logic, no "recent".
4. **No randomness**, including unseeded iteration order over hash maps.
5. **No filesystem access** outside the provided read-only snapshot plus a scratch path.
6. Same inputs ⇒ **identical verdict and identical `determinism_hash`** over the evidence.

Point 6 is the one that matters, because it is *mechanically testable*: run the gate twice on the same fixture and compare hashes. That check is mandatory at registration (§8) and re-runs on every version bump.

**Why determinism is worth the constraint.** A deterministic gate is cacheable (same artifact hash ⇒ same result, skip the run), replayable in Note 02's mode 1 without re-execution, and trustworthy in a way no other verification component is. C0 gates are the only part of this entire architecture that produce the same answer every time — which is exactly why the Note 02 §3 rule requiring at least one C0/C1 criterion per WorkUnit matters so much. They are the floor everything else stands on.

---

## 7. Flake, quorum, and `indeterminate`

Empirical (C1) gates run things. Things flake. This must be designed for, not discovered.

```yaml
flake_policy:
  max_runs: 3
  quorum:   "3/3"        # unanimity required for a definite verdict
```

**Rule:** if runs disagree within `max_runs`, the verdict is **`indeterminate`**, never the majority.

The reasoning is about incentives, not statistics. A gate that returns the majority verdict trains the system — and the humans watching it — to re-run until green. Every organisation that has ever tolerated a flaky test suite has learned that "re-run it" becomes the reflex, and the reflex eventually re-runs past a real failure. Returning `indeterminate` makes flake *visible and escalating* instead of *absorbable*.

Quorum values by purpose:

| Quorum | Meaning | Use for |
|---|---|---|
| `3/3` | Unanimity; any disagreement is indeterminate | Correctness and security checks |
| `2/3` | Tolerates one deviation | Performance thresholds with known variance |
| `1/1` | Single run, no tolerance | Fast deterministic-ish checks where flake would be a bug |

**Flake is a gate defect, not a work defect.** A gate whose `indeterminate` rate exceeds a threshold should be flagged in the registry and its owner notified. Track `indeterminate_rate` per gate version as a first-class registry metric — it is the earliest signal that a gate is degrading, and it is invisible if you only look at pass/fail.

---

## 8. The registry: authoring, registration, versioning

### Who may author a gate

**Humans only.** No Role may author, modify, register, or version a gate, under any configuration.

This follows directly from Note 01 §16 (the system does not approve changes to its own governance) and it is the sharper case: a system that can weaken its own verification has no verification. The gate registry is the trust root of the entire architecture, and everything else in the design assumes it is fixed relative to the work being judged.

A Role may *propose* a gate as an artifact for human review. It may not register one.

### Registration requirements

A gate cannot reach `status: active` without all of:

| Requirement | Why |
|---|---|
| Named human `owner` | Someone is accountable when it misjudges |
| `verdict_semantics.pass_means` stated | Forces single responsibility |
| ≥1 `must_pass` fixture | Proves it accepts valid work |
| **≥1 `must_fail` fixture** ★ | Proves it rejects invalid work |
| Determinism check (C0) | Two runs, identical evidence hash |
| Sandbox declaration | Explicit blast radius |
| `requires_context` ⊆ the closed enumeration [D3] | No gate may reach Memory |
| **Signed definition** [C2a] | The registry is the trust root |
| Human approval of registration | It is production governance |

### Registry integrity  [C2a]

Three protections, structural rather than procedural:

1. **Gate definitions are signed**, and the kernel verifies the signature before execution. Retrofitting signing later means re-registering every gate, which is why this lands now rather than at instance #2.
2. **The registry has an append-only audit log outside any instance's reach.** An instance may reference gates; it may not observe or alter their registration history.
3. **No policy may reference an unsigned or unregistered gate.** Checked at instance-policy publication (Note 04 §16 step 5), not at dispatch.

**Deferred (C2b):** a registration **quorum**. It will be a `FloorPolicy` *value* rather than a hardcoded 2 — default `1` at single-instance, raised when a second instance is provisioned. A hardcoded 2 would make a solo founder unable to register any gate, which stops the MVP dead.

### The registry model extends to tools  [E4]

Gates were registered, versioned, owned, fixture-tested, and signed while **tools had none of it** — Note 07 defines how tool calls are *enforced* but never what a tool *is* as a governed object. Since tools are the Executor's entire action surface, that asymmetry is closed here by reusing this section wholesale rather than inventing a second governance model.

```yaml
Tool:
  id, version, owner, status            # lifecycle exactly as above
  interface:  { args_schema, result_schema }
  effects:    read | write | execute | external      # ★ E4.3
  scope_kinds: [logical root]           # workspace:// | repo:// | artifact://
  sandbox_requirements: { network, determinism }
  credential_scopes: [SecretScope]      # NAMED here; HELD by the broker
  fixtures:
    must_succeed: [FixtureRef]
    must_deny:    [FixtureRef]          # ★ out-of-scope calls it must refuse
    must_error:   [FixtureRef]
```

Inherited without modification: human-only authoring, semver with immutable published versions, retired-not-deleted, human approval to register, signing and audit log (C2a), and mandatory fixtures including negative cases. **No Role may author, modify, or register a tool** — a system that can extend its own action surface has no action boundary.

★ **`effects` is the one tool-specific addition, and it closes a real hole.** Note 04 §5 sets `external_effects: {may_send, may_deploy, may_spend}` false for every Role, but *"does this tool send email"* was not a machine-checkable property of anything — the policy forbade a category with no membership test, enforced by everyone remembering which tools are dangerous. Declaring `effects` makes it a set-membership check at capability-token minting: any grant of a tool declared `effects: external` is rejected while `external_effects` is false.

★ **`must_deny` fixtures** are the tool analogue of `must_fail`: a tool must demonstrate it **refuses an out-of-scope call**. A tool whose scope check has never rejected anything is indistinguishable from one that does not check — the same fail-open blindness, at the action surface instead of the verification surface.

**Not included:** tool discovery or marketplace semantics, a per-instance tool catalogue (configuration, like the Role catalogue), MCP transport specifics (Note 07 §18), and dynamic or model-authored tool definitions (prohibited above).

### `must_fail` fixtures: the answer to "who verifies the verifier" — for C0/C1 ★

Note 02 §17.3 asked who verifies the verifier and I had no good answer for the model-judged case. **For deterministic and empirical gates, there is a clean one.**

A gate that has never rejected anything is indistinguishable from a gate that passes everything. It can be a stub, a misconfigured path, a check whose predicate silently short-circuits, a rule that was correct until a refactor moved the file it inspects. All of these fail *open*, silently, and the only visible symptom is that the pass rate is excellent.

Requiring at least one known-bad fixture that the gate **must** reject converts that into a registration-time and every-version test. It is cheap, it is mechanical, and it catches the highest-consequence gate failure mode there is. **A gate with no negative coverage is not a gate; it is a decoration** (ledger B8).

This does not extend to C2 model-judged gates — a fixture the model rejects today may pass tomorrow. §19.2 covers what to do instead, and it is weaker.

### Versioning

Follows Note 01 §11. Semver semantics for gates specifically:

- **Patch** — messaging, evidence formatting. No verdict change on any fixture.
- **Minor** — new evidence emitted, new optional parameter, broader `applies_to`. **No fixture's verdict may change.**
- **Major** — the predicate changes. Some artifact that passed now fails, or vice versa.

**A version bump that changes any fixture's verdict is major by definition, regardless of intent.** This is the mechanical test for "did we change what this gate means," and it removes the judgement call.

Published gate versions are immutable and retired-not-deleted, because Note 02's replay depends on reconstructing exactly which predicate ran.

---

## 9. `GateProfile` and monotonic composition

From Note 02 §0. The object that makes gate sets governable.

```yaml
GateProfile:
  id, version, owner, description
  composition: union_only
  bindings:
    - gate_ref:   GateId@SemVer
      blocking:   bool
      parameters: {…}                  # bound values for the gate's parameters
      applies_when: PredicateExpr?     # e.g. artifact.type == CodeDiff
```

### Composition

The effective gate set for a WorkUnit is the union of four layers:

```
effective = RoleProfile ∪ InstancePolicy ∪ WorkUnitClass ∪ WorkUnit
```

**No layer may remove a binding contributed by another.**

Conflict resolution is **monotonically strengthening**:

| Conflict | Resolution |
|---|---|
| Same gate, different `blocking` | `blocking: true` wins |
| Same gate, different threshold parameter | The **stricter** value wins |
| Same gate, different versions | The **higher** version wins; a major-version conflict fails validation |
| Same gate, different `applies_when` | Disjunction — broader applicability wins |

### Why monotonic strengthening is the right rule ★

It makes composition **order-independent**. The effective set is the same regardless of which layer is applied first, which means you can reason about "what will actually run" without knowing the resolution order — and you can add a layer without auditing the others.

It also means the safety property is one-directional: **adding a layer can only make verification stricter, never weaker.** An instance policy can add a compliance check to every diff in the company without touching a Role. It categorically cannot remove the security gate a Role requires. That asymmetry is what makes it safe to let instance owners edit policy at all.

The cost: you cannot express "this instance doesn't need the license check." Correct. That exemption should require editing the Role or the class — a change that is visible, reviewed, and attributable — rather than being quietly available as instance configuration.

---

## 10. Ordering, short-circuit, and evidence batching

### Ordering

Effective gates are sorted by `(stage, cost_class, profile_order)`. Stages are coarse bands:

| Stage | Contains | Typical cost |
|---|---|---|
| 0 | Artifact schema validity, structural checks | free |
| 1 | Static C0: dependency, path scope, API projection, symbol reuse | cheap |
| 2 | Build, typecheck, lint | cheap–moderate |
| 3 | C1: tests, runtime scenarios, differential checks | moderate |
| 4 | C2: model-judged review | expensive |
| 5 | C3: human approval | attention |

### Short-circuit — but batch the cheap failures ★

The naive rule ("stop on first blocking failure") is wrong, and the naive opposite ("run everything") is wasteful. The correct rule splits on cost:

> **On a blocking `fail`, do not proceed to a later stage — but finish the current stage and every cheaper one.**

Rationale: five cheap gates that all fail produce **one** `FailureRecord` listing five problems, and attempt 2 can fix all five. Short-circuiting at the first produces five sequential attempts, each fixing one issue and rediscovering the next — five times the cost, five times the latency, and a retry budget exhausted on a diff that was three edits from correct.

Meanwhile the expensive stages genuinely should not run: paying for a model verifier on a diff that does not compile is pure waste, and the verifier's judgement on broken code is noise that will pollute the failure record.

**Rule:** exhaust cheap gates for evidence; short-circuit expensive ones for cost.

### Caching

Deterministic (C0) gates are keyed on `(gate_ref@version, artifact content_hash, parameters)`. A cache hit skips execution entirely. This is only sound because of §6 — determinism is what makes the cache correct, which is a second concrete return on the constraint.

---

## 11. Binding criteria to gates

Uniform across all four classes (ledger B1):

```yaml
Criterion:
  id, statement, class
  check:
    gate_ref:   GateId@SemVer          # ALL classes
    parameters: {…}
    evidence_required: [EvidenceKind]
  blocking: bool
  derived_from: ConstraintRef?
```

Kernel validation (extending Note 02 §9 step 4):

1. `gate_ref` resolves to an `active` gate version.
2. `gate.criterion_class == criterion.class`. A mismatch is a validation failure, not a warning — it is the misclassification check.
3. `criterion.check.parameters` satisfies the gate's declared `parameters`.
4. `gate.applies_to` includes the unit's `expected_output` type.
5. Every segment in `gate.requires_segments` is visible to this gate for this artifact type.
6. `evidence_required ⊆ gate.produces_evidence`.

All six are static, deterministic, and run before dispatch. A criterion that cannot be checked is caught at plan validation, when fixing it is free.

---

## 12. Constraint compilation: the form vocabulary

The promise from Note 01 §17 item 3, and the mechanism that makes "architecture as contract" real rather than aspirational.

### The problem

Note 01 introduced `ArchitectureDecision.constraints[]` as machine-checkable, then produced constraints ranging from trivially checkable (`c1: no new runtime dependency`) to apparently unrunnable (`c4: response must not reveal whether the account exists`). "Machine-checkable" was doing unexamined work.

### The form vocabulary

**Every constraint declares a `form`. The form determines how it compiles to a gate binding.**

| Form | Template | Compiles to | Class |
|---|---|---|---|
| `prohibition` | "No X", X an enumerable artifact property | Set-membership check over a derived projection | C0 |
| `reuse` | "Must use existing Y" | Symbol/import reference check | C0 |
| `invariance` | "Z must not change" | Diff over a derived projection (API schema, exports, DDL) | C0 |
| `bound` | "Metric M must stay under K" | Threshold check | C0 |
| `locality` | "Changes confined to paths P" | Path-set containment | C0 |
| `equivalence` | "A and B indistinguishable w.r.t. observable O" | **Differential test** | C1 |
| `response` | "Under condition C, observable O must equal V" | Scenario test | C1 |
| `property` | "For all inputs in domain D, invariant I holds" | Property/fuzz test | C1 |
| `conformance` | "Implementation matches the decision's intent" | Model judgement with citation | C2 |
| `acceptability` | "This trade-off is acceptable" | Human approval | C3 |

### The demotion doctrine ★★

> **Always compile a constraint to the lowest class that can actually decide it.**
> If a constraint compiles to C2, the author must record **why it could not be demoted**.

This is the most useful single idea in this note, and Note 02's own example demonstrates it against itself.

`c4: "Response on limit must not reveal whether the account exists"` reads like semantic judgement, and Note 02 classified it C2. **It is not.** It is an `equivalence` constraint, and equivalence compiles to C1:

```yaml
constraint:
  id: c4
  form: equivalence
  statement: "Response on limit must not reveal whether the account exists."
  compiles_to:
    gate_ref: "gate://differential.response_equivalence@1.0.0"
    class: C1
    parameters:
      scenario_a: "POST /auth/password-reset with a known-existing account"
      scenario_b: "POST /auth/password-reset with a non-existent account"
      observables: [status_code, response_body, headers.retry_after, rate_limit_applied]
      tolerance: { timing_ms: 50 }
      repetitions: 5          # crosses the rate limit in both scenarios
```

The author's real job is not to write a checkable *sentence*. It is to **name the observable that distinguishes satisfaction from violation.** Once `observables` is named, the check is mechanical, cheap, deterministic-ish, and — the point — it runs in stage 3 rather than stage 4.

§18 shows exactly what that saves.

### Where demotion genuinely fails

Some constraints resist, and pretending otherwise is worse than admitting it:

- *"The abstraction matches the decision's intent"* — irreducibly `conformance`/C2. There is no observable; the question is whether a structure means what was intended.
- *"This latency/complexity trade-off is acceptable"* — irreducibly `acceptability`/C3. It is a preference, not a fact.
- *"The error message is helpful"* — C3. Same.

The doctrine does not eliminate C2 and C3. It ensures they are *residual* rather than *default*, and the `demotion_blocked_because` field makes each remaining case a defended decision rather than laziness.

### Compilation happens at architecture-approval time ★

**Constraints are compiled to gate bindings when the `ArchitectureDecision` is gated — not when the implementation runs.**

The architecture output gate (`gate://constraints.compilable`) checks that every constraint declares a form and that C0/C1 forms resolve to a registered gate with satisfiable parameters. A constraint that will not compile fails *architecture* validation.

This timing is the whole value. You discover that `c4` has no named observable **before the human approves the architecture** — when the fix is one more sentence from the architect. Discover it during implementation and you have already paid for a plan, a context compilation, an implementation attempt, and an expensive model review, and the human has already approved a decision that could not be enforced.

**The constraint that cannot be compiled is not a constraint. It is an intention, and it should be labelled `conformance` or `acceptability` honestly, or rewritten until it names an observable.**

---

## 13. Model-judged gates

A C2 gate executes as a real WorkUnit. The gate definition supplies the Role:

```yaml
Gate:
  id: "review.independent"
  version: "1.1.0"
  kind: model_judged
  criterion_class: C2
  applies_to: [CodeDiff]
  requires_segments: [diff, files_touched, gate_evidence, test_provenance]
                                  # NOT implementation_notes, NOT reasoning_trace
  execution:
    substrate: work_unit
    role_ref: "verifier@1.1.0"
    cost_class: expensive
    stage: 4
    timeout_s: 600
    determinism: not_required
  produces_evidence: [finding, location, reproduction]
```

### Rules

1. **The gate's execution WorkUnit is subject to every Note 02 rule** — validation, budget, capability token, context manifest, `Attempt` record, replayability. It is not a privileged path.
2. **`requires_segments` is enforced against artifact visibility.** The gate declares what it reads; the kernel checks it against the schema. A model gate cannot request `private` segments (§5).
3. **The verifier Role has no write capability**, per Note 01. The gate cannot repair what it finds; every finding must surface as evidence.
4. **Model diversity is expressible here** — the gate names the Role, and the Role names the tier. A verifier on a different model family than the implementer decorrelates errors, and this is where you configure that.
5. **The produced `VerificationReport` is an artifact**, referenced from the `GateResult`. The report is the detail; the `GateResult` is the verdict.
6. **A C2 gate may return `indeterminate`**, and should, when the spec is ambiguous rather than when the code is wrong. That routes to a human as a *specification* question — which is the correct destination and is otherwise very hard to reach.

Model-judged gate executions produce their own `Attempt` records, parented to the gate execution unit rather than to the unit under test (ledger B4). This keeps cost attribution honest: verification cost is visible separately from implementation cost, which you need in order to evaluate §19.1.

---

## 14. Human gates

```yaml
Gate:
  id: "approval.architecture"
  kind: human
  criterion_class: C3
  execution:
    substrate: approval_request
    approver: { principal: "human:founder", delegable_to: [] }
```

Produces an `ApprovalRequest`; the resulting `Approval` (Note 02 §12) is the evidence. Every Note 02 §12 invariant applies: bound to a content hash, `one_time` by default, only a human principal may create it.

**The attention policy governs human gates** (Note 02 §13). A human gate is not free: it consumes the scarcest budget in the system. Instance attention limits apply to pending human gates exactly as they do to escalations, and breaching them pauses dispatch.

**`approve_with_conditions` produces typed criteria**, which are appended to the unit and — necessarily — must themselves bind to gates. A condition that cannot bind to a gate is a comment, and comments do not gate. This is where §12's form vocabulary earns its keep a second time: a human adding "make sure it doesn't leak timing" must name an observable, or their condition does not become enforceable.

---

## 15. Gate budgets and cost accounting

Verification cost must not compete with execution cost, or a runaway verifier starves the work it is verifying.

```yaml
EffectiveBudget:
  execution:    { input_tokens, output_tokens, tool_calls, wall_clock_s, cost }
  verification: { cost, wall_clock_s, model_gate_calls }   # ★ separate allocation
```

Rules (ledger B7):

1. **Verification has its own allocation.** Exhausting it does not consume the execution allowance, and vice versa.
2. **Verification exhaustion is never a `fail`.** It is an escalation: verification could not complete. Treating an unverified artifact as a failed one is wrong, and treating it as a passed one is much worse.
3. **`error` verdicts do not consume the unit's verification budget** — they consume a separate gate-retry allowance, because infrastructure faults are not work.
4. **Cost is attributed per gate version** in the registry. Over time this answers the question that decides §19.1: *what does each gate actually cost per defect it catches?*

That last metric is the one I would build reporting for first. A gate that costs $4 per run and has never returned `fail` on real work is a candidate for removal or demotion to advisory. A cheap gate that catches defects weekly justifies itself immediately. Without per-gate cost-versus-catch attribution, gate sets only ever grow.

---

## 16. Gate sandboxing and security

Gates execute code against artifacts that may contain adversarial content — a diff can contain anything, including a payload aimed at the gate runner itself.

| Control | Requirement |
|---|---|
| Network | `none` for every gate at MVP, including model gates (which reach the model through the kernel's broker, not directly) |
| Filesystem | Read-only snapshot + one scratch path. Never the live worktree. |
| Mutation | `may_write: false` except to scratch. A gate that mutates its subject is not a gate (§17). |
| Secrets | None. A gate needing a credential is doing integration work, not verification. |
| Timeout | Mandatory, enforced by the kernel, not the gate. |
| Isolation | Gates run in a sandbox at least as tight as executors. They are not more trusted for being verification. |
| Entrypoint | Registered reference, never inline code from an artifact or a Role. |

**The gate registry is the trust root.** If a gate can be modified by the system it judges, or can be steered by content in the artifact it reads, verification is theatre. Everything else in Notes 01–03 assumes this boundary holds.

---

## 17. What must NOT be a Gate

| Not a gate | What it actually is | Why it matters |
|---|---|---|
| Anything that mutates the artifact (auto-format, auto-fix, codemod) | A **transform**, belonging in execution | ★ A mutating verifier destroys the diff under review. The thing that was judged is no longer the thing that ships, and provenance breaks. Format in execution, verify after. |
| A non-deterministic check registered as C0 | A C1 gate | Misclassification defeats caching, replay, and trust in the floor |
| Anything with network access | An integration step | Breaks replay (Note 02 §14) and opens the trust root |
| A check that reads `private` segments and reports publicly | A visibility violation | §5. Only `audit_only` may read private, and it may decide nothing |
| A model call that judges its own producer's output | Nothing legitimate | Self-verification. Note 01 `self_report_accepted: false` |
| A gate authored or modified by a Role | Governance failure | §8 |
| A gate with no `must_fail` fixture | A decoration | §8 |
| A gate whose `pass_means` needs a paragraph | Several gates | Split it; composite verdicts cannot be acted on |
| Data collection with no verdict | An `audit_only` observer or a metrics projection | A gate that never fails is not verifying |

---

## 18. Worked example, corrected

Continuing the password-reset case. **This section deliberately shows Note 02's own trace being improved by §12**, because that is the clearest demonstration of what the form vocabulary buys.

### Architecture-time compilation

`ad_014`'s constraints, now with declared forms, compiled at architecture-gate time:

| Constraint | Form | Compiles to | Class | Stage |
|---|---|---|---|---|
| c1 "No new runtime dependency" | `prohibition` | `gate://deps.unchanged@2.1.0` | C0 | 1 |
| c2 "Reuse `rateLimiter` from `src/middleware/rateLimit.ts`" | `reuse` | `gate://symbol.reference_required@1.3.0` | C0 | 1 |
| c3 "No change to the public API contract" | `invariance` | `gate://api.schema_unchanged@3.0.0` | C0 | 1 |
| c4 "Response on limit must not reveal account existence" | **`equivalence`** | `gate://differential.response_equivalence@1.0.0` | **C1** | **3** |
| c5 "Limit values config-driven, not literals" | `prohibition` | `gate://ast.no_magic_numbers@1.2.0` | C0 | 1 |

The architecture output gate `gate://constraints.compilable@1.0.0` runs at stage 1 on the `ArchitectureDecision` and returns `pass`: every constraint declares a form, and every C0/C1 form resolves to a registered gate with satisfiable parameters.

**Under Note 02, `c4` was left as C2** — the architect wrote a sentence, nobody asked for an observable, and it landed on the model verifier at stage 4.

### What changes in execution

**Note 02 trace (c4 as C2):**

```
attempt 1 → stage 1 C0 gates pass · stage 2 build/types pass · stage 3 tests pass
          → stage 4 gate://review.independent  [model, expensive, ~$2.80, ~4 min]
          → fail: enumeration oracle at passwordReset.ts:58
```

**Note 03 trace (c4 compiled as C1 `equivalence`):**

```
attempt 1 → stage 1 C0 gates pass · stage 2 build/types pass
          → stage 3 gate://differential.response_equivalence  [~$0.00, ~6 s]
          → FAIL
```

```yaml
GateResult:
  gate_ref: "gate://differential.response_equivalence@1.0.0"
  subject: { artifact_id: diff_0212, content_hash: "sha256:c1a8…" }
  decides: [b5]
  verdict: fail
  blocking: true
  duration_ms: 6120
  cost: 0.00
  runs: [ {1: fail}, {2: fail}, {3: fail} ]        # quorum 3/3, consistent
  evidence:
    - kind: assertion
      content: "Observable `rate_limit_applied` differs across scenarios."
      visibility: public
    - kind: reproduction
      content:
        scenario_a: "existing account, 4 requests in 60s → 429 on request 4"
        scenario_b: "non-existent account, 4 requests in 60s → 200 on request 4"
        expected:   "identical across scenarios for all declared observables"
        observed:   "status_code diverges: 429 vs 200"
      location: "src/routes/auth/passwordReset.ts:58"
      visibility: public
```

**What this saves:** the defect is caught in 6 seconds at zero marginal cost instead of ~4 minutes at ~$2.80, and it is caught *before* the expensive stage runs at all — short-circuit (§10) means `gate://review.independent` never executes on attempt 1. The failure evidence is also stronger: a reproduction with named observables beats a model's prose claim, and it becomes a **permanent regression test** rather than a one-time judgement.

Stage 1 cheap gates all ran despite the eventual failure (§10 batching), confirming c1, c2, c3, c5 pass — so attempt 2 has a complete picture and does not rediscover problems serially.

### `FailureRecord` for attempt 1

```yaml
FailureRecord:
  class: verification_failed
  detected_by: "gate://differential.response_equivalence@1.0.0"
  failed_criteria: [b5]
  violated_constraints: [{ source_artifact: ad_014, constraint_id: c4 }]
  gate_results:
    - { gate: "deps.unchanged@2.1.0",           verdict: pass }
    - { gate: "symbol.reference_required@1.3.0", verdict: pass }
    - { gate: "api.schema_unchanged@3.0.0",      verdict: pass }
    - { gate: "ast.no_magic_numbers@1.2.0",      verdict: pass }
    - { gate: "tests.affected_pass@4.0.0",       verdict: pass }
    - { gate: "differential.response_equivalence@1.0.0", verdict: fail,
        location: "src/routes/auth/passwordReset.ts:58" }
  observed_vs_expected:
    - location: "src/routes/auth/passwordReset.ts:58"
      expected: "identical status_code across account-existence scenarios"
      observed: "429 vs 200"
  diff_summary: { files_touched: 3, insertions: 91, deletions: 4 }
  # No external_findings — no model gate ran. No narrative field exists.
```

### Attempt 2 and close

Attempt 2 keys the bucket pre-lookup. Stages 1–3 pass, including `differential.response_equivalence` (3/3). **Now** stage 4 runs — `gate://review.independent` executes as a WorkUnit under `verifier@1.1.0`, on a different model family, reading only `[diff, files_touched, gate_evidence, test_provenance]`. Verdict `pass`, with one advisory finding on naming. Stage 5: human merge approval.

**Total verification cost across both attempts: ~$2.90**, versus ~$5.60 in the Note 02 trace — and the C1 gate remains as a permanent regression check that costs 6 seconds forever, while the model judgement was a one-time opinion that has to be re-purchased on every future change to that endpoint.

**That last point is the real argument for the demotion doctrine.** A C1 check is an asset. A C2 judgement is a consumable.

---

## 19. Challenges

### 19.1 Gate sets only ever grow

Every incident produces a gate. Nothing ever removes one. Within a year, stage 1–3 takes eleven minutes and half the gates have never returned `fail` on real work.

The monotonic composition rule (§9) makes this *structurally worse*, because no layer may remove a binding — that safety property is also a ratchet.

Mitigation, and it must be built early or it will never be built: **per-gate catch-rate and cost attribution in the registry** (§15). A quarterly review that demotes zero-catch expensive gates to advisory, and retires advisory gates nobody reads. This is a human process, and it needs the data to exist from day one or the review has nothing to look at.

### 19.2 Model-judged gates cannot be fixture-tested

§8's `must_fail` requirement is a clean solution for C0/C1 and does not extend to C2. A fixture the verifier rejects this week may pass next week after a model update, and enforcing fixture stability on a model gate would make every model upgrade a false alarm.

What is available, all weaker:

1. **Sampled human audit of `pass` verdicts**, not just failures (Note 02 §17.3). Track verifier-versus-human disagreement as a health metric.
2. **Shadow-run the new model version** against historical C2 gate executions and diff the verdicts before promoting. Catches gross drift, not subtle drift.
3. **Prefer demotion.** Every constraint moved from C2 to C1 by §12 is one fewer place where this problem exists. This is the strongest available answer, and it is indirect.

I want it recorded that this is not solved. The system's judgement layer has no mechanical self-check, and the honest mitigation is *to depend on it less*.

### 19.3 The demotion doctrine has a failure mode

Pushing constraints toward C0/C1 is right, but it creates pressure to write constraints that are *checkable* rather than *correct*. An architect that must name an observable will sometimes name an observable that is easy to test and does not capture the actual property — checking status codes match while timing leaks the same information.

Note the c4 example already hedges this with `tolerance: {timing_ms: 50}`, and that hedge was not obvious. A cheaper, wrong check is worse than an expensive, right judgement, because it passes.

Partial mitigation: C2 `conformance` gates can coexist with C0/C1 checks on the same constraint — demotion should mean "add the mechanical check," not always "remove the judgement." For security-relevant constraints specifically, I would keep both and accept the cost.

### 19.4 Constraint compilation adds work at the point of least patience

§12 requires architects to name observables at architecture time, and it fails the architecture gate when they do not. That is correct, and it will feel like friction exactly when someone wants a quick change.

The pressure valve will be `form: conformance` — the escape hatch that always compiles, because C2 accepts anything. Watch the ratio of `conformance` to mechanical forms per instance. **A rising `conformance` rate means the architecture layer is degrading into prose**, and it is measurable, which is the only reason to expect anyone to notice.

### 19.5 The trust root is a single point

§16 asserts the gate registry is the trust root. It is also unprotected by anything in this design beyond "humans only." There is no gate on gates, no quorum for registration, no signing.

For a single-founder MVP this is proportionate. For multi-instance operation it is not, and the fix (signed gate definitions, registration quorum, an immutable registry audit log) belongs in the instance-policy note rather than here.

---

## 20. Deferred questions

1. **Gate entrypoint packaging** — how a registered gate is distributed, pinned, and executed reproducibly. Deliberately deferred with storage; it is an implementation concern.
2. **`SelectorExpr` grammar** — still open from Notes 01 and 02. Now with a third requirement: it must express `gate.requires_segments` statically.
3. **Instance policy schema** — now the largest open item. Carries capability intersection, gate union, budget minimums, attention policy (Note 02 §13), permitted roles in plans, and §19.5's registry protections.
4. **Fleet model binding table** — raised in Note 02 §0, still unspecified. Now also needed by §19.2's shadow-run procedure.
5. **`TaskPlan` artifact schema** — used since Note 02, still informal. Now simpler, since verification nodes are gone (§1).
6. ~~**Memory stores — the four stores**~~ — **RESOLVED and CORRECTED**, Note 05 [D1]. Not four stores; five advisory *kinds*, human-approved, unreachable by any gate [D3].
7. **Criteria-quality gate** — Note 02 §17.2. Still the most valuable unsolved problem in the system. §12 helps at the *constraint* level and does nothing for *criteria* authored directly by the planner.
8. **Storage, event log, kernel architecture** — still last. Three notes in, the model has not been shaped by a database.

---

*End of Design Note 03.*

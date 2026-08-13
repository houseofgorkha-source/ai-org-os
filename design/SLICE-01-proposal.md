# AI-Org OS — Vertical Slice 01 (Proposal)

**Status:** Proposal. Not implemented.
**Derived from:** Notes 01–09 as amended, Appendix A. Deliberately re-derived rather than inherited from the pre-architecture suggestion.

---

## 0. What changed from the earlier suggestion, and why

The slice proposed before the architecture pass was: *intent → plan → executor → tests → diff review → human approval → merge*, with an **architect**, an **implementer**, and a **model verifier**.

**The finished architecture says two of those three Roles are the wrong place to start.**

| Earlier element | Why it is now wrong for slice 1 |
|---|---|
| **Model verifier (C2)** | It is the one component with **no mechanical self-check** (Note 02 §17.3, Note 03 §19.2). `must_fail` fixtures close the loop for C0/C1 gates and explicitly do not extend to C2. Starting here means starting with the thing you cannot validate |
| **Architect** | Its output must produce constraints that **compile** to gates (Note 03 §12). That requires the form vocabulary, a populated gate registry, and constraint-compilation validation at architecture-approval time — a large surface before anything has run once |
| **Agent-authored plan** | Puts the criteria-quality problem (Note 02 §17.2, the system's ceiling) on the critical path of the first thing you build |

The architecture also supplies the cheaper starting point it did not have before: **`WorkUnitClass: mechanical_change`** (Note 02 §17.1) — implement, then deterministic gates only, no model verifier at all.

**So slice 1 is: one Role, a human-authored plan, C0/C1 gates only, one human merge approval.** It proves the spine. Everything judgemental is deferred to slice 2.

---

## 1. Objective

> Ship one `mechanical_change` end to end — from human intent to merged diff — with a deliberate gate failure, a deliberate capability denial, one successful retry, and full replay of both attempts.

**Concrete task:** replace deprecated `oldFn()` call sites with `newFn()` across `src/**`. Chosen because it is genuinely mechanical, its criteria are naturally C0/C1, and it has an obvious partial-failure mode (a missed call site) that exercises the retry loop for free.

**The slice succeeds when the spine works, not when the diff is impressive.**

---

## 2. Required Roles

**One.**

```yaml
Role:
  id: implementer   version: 1.0.0   status: active
  mandate: "Apply a bounded, mechanical code change within declared paths."
  consumes: []
  produces: CodeDiff
  emits_plan: false                    # ← no planner exists in this slice
  model: { tier: standard, pinning: pinned, reasoning_effort: medium,
           sampling_class: balanced, max_output_tokens: 8000 }
  context: { recipe: implementation.v1@1.0.0, budget_tokens: 60000,
             overflow_policy: fail }
  capability_profile_ref: code_writer@1.0.0
  acceptance: { gate_profile_ref: mechanical_change@1.0.0,
                self_report_accepted: false,
                artifact_schema: "schema://code_diff/1.0.0" }
  on_failure: { verification_failed: retry_with_evidence,
                capability_denied: escalate_human,
                spec_ambiguous: escalate_human,
                budget_exceeded: escalate_human,
                no_progress: escalate_human }
  prompt_ref: implementer@1.0.0
  eval_suite: implementer_evals@1.0.0
  budget: { per_attempt: {cost_ceiling: $3.00, wall_clock_s: 600, tool_calls: 60},
            per_work_unit: {max_attempts: 3, files_touched: 12} }
```

**Not admitted:** `planner` (the human plans), `architect` (no contract change), `verifier` (no C2 criteria). Enforced by `admitted_roles` in instance policy — a plan naming any of them fails validation.

**`eval_suite` is required to publish** (Note 01 §11 rule 5, Note 09). Minimum viable suite: 2 `capability` cases, 1 `refusal` case (an ambiguous spec must escalate, not guess), 0 `constraint` cases — there are no defects yet, and constraint cases only ever come from real ones (Note 09 §5).

---

## 3. TaskPlan

Human-authored, so the `plan` segment is written directly rather than produced by a Role. It is still a real `TaskPlan` artifact and still passes the full E1 validation.

```yaml
TaskPlan:
  id: plan_001   version: 1.0.0   intent_ref: int_001
  nodes:
    - node_id: n1
      objective: "Replace all oldFn() call sites in src/** with newFn()."
      role_ref: implementer@1.0.0
      class: mechanical_change
      expected_output: CodeDiff
      affected_paths: ["src/**"]
      acceptance_criteria: [c1…c5]        # §7
      budget: { execution: $3.00, verification: $0.00 }
      approvals_required: [{ kind: pre_merge, subject: artifact, blocking: true }]
  edges: []                                # single node; no DAG in slice 1
  budget_aggregate: { execution: $9.00, verification: $0.00 }
```

**Validation exercised even with one node:** acyclicity, role admission, `may_appear_in_plans`, no authored `resource` edge, `expected_output == role.produces`, **≥1 C0/C1 criterion**, every criterion binds an active gate, `intent_ref` resolves to an `Intent` and not a `MemoryRecord`, budget aggregate within instance ceiling.

`verification: $0.00` is deliberate — it proves the split budget (B7) is enforced, since any model-gate call would immediately exhaust an allocation of zero.

---

## 4. WorkUnits and Attempts

One WorkUnit, materialised from `n1` by the kernel keyed `(plan_001@1.0.0, n1)`.

| Attempt | Expected outcome | What it proves |
|---|---|---|
| **1** | `tests.affected_pass` → `fail` (one call site missed in a test fixture) | Four-valued verdicts; `FailureRecord` whitelist schema; kernel-side harvest; the denial path (below) |
| **2** | All gates pass | `prior_attempt_evidence` carries **structured evidence only**; no narrative channel exists |

**A deliberate denial in attempt 1:** the implementer will attempt `net.fetch` to read the library's migration guide. `code_writer@1.0.0` denies it. The executor receives a structured `DenialRecord` listing its granted scopes, adapts by reading the vendored README, and continues. **One denial, no failure** — and the denial is recorded with equal fidelity to granted calls (Note 07 §14).

**Explicitly out of scope for the slice, but must not break:** `superseded` attempts, lease expiry mid-execution. Verified by test, not by exercise.

---

## 5. Tools and capabilities

```yaml
CapabilityProfile: code_writer@1.0.0
  composition: intersect_only
  capabilities:
    - { tool: fs.read@1.0.0,    scope: "workspace://**",     mode: read }
    - { tool: fs.write@1.0.0,   scope: "workspace://src/**", mode: write }
    - { tool: shell.exec@1.0.0, scope: "workspace://",       mode: execute,
        rate_limit: { calls: 40, window_s: 600 } }
  capability_denies: [net.fetch, db.write, git.push]
  permissions:
    network: { egress: none }
    repository: { mode: worktree_write, may_commit: true, may_push: false }
    secrets: { scopes: [] }
    data: { db_access: none, row_scope: instance_only }
    external_effects: { may_send: false, may_deploy: false, may_spend: false }
```

**Four registered tools** (Note 03 §8 as extended by E4), each signed, versioned, owned, and fixture-tested with `must_succeed` / `must_deny` / `must_error`:

| Tool | `effects` | Note |
|---|---|---|
| `fs.read` | `read` | |
| `fs.write` | `write` | Scope-confined to `src/**`; `must_deny` fixture writes outside it |
| `shell.exec` | `execute` | cwd-confined |
| `git.commit` | `write` | Worktree only |

**No tool in the slice declares `effects: external`**, which makes `external_effects: false` a mechanical set-membership check at token minting rather than a convention (E4.3).

The executor **holds no credentials** — model access via the Model Broker, no repo credential, no secrets. Combined with `egress: none`, it has no route off the box.

---

## 6. Artifacts

| Artifact | Segments (visibility) | Produced by |
|---|---|---|
| `Intent` | — | Human |
| `TaskPlan` | `plan` (public) · `decomposition_rationale` (restricted) · `reasoning_trace` (private, empty — human-authored) | Human |
| `CodeDiff` ×2 | `diff`, `files_touched`, `gate_evidence`, `test_provenance` (public) · `implementation_notes` (restricted) · `reasoning_trace`, `self_assessment` (**private**) | Kernel harvest |
| `GateResult` ×~12 | evidence, visibility derived (Note 03 §5) | Gates |
| `ContextManifest` ×2 | — | Context Compiler |
| `FailureRecord` ×1 | whitelist schema — **no narrative field exists** | Kernel |
| `Approval` ×1 | `1 of 1` quorum | Human |

**The diff is derived from the frozen workspace by the kernel, never reported by the executor** (Note 07 §3). Out-of-scope paths are **surfaced and flagged**, never filtered — a change under `test/**` would fail the locality gate loudly rather than vanishing.

---

## 7. Gates and criteria

`GateProfile: mechanical_change@1.0.0` — **six gates, all C0/C1, no model gate anywhere.**

| # | Gate | Stage | Class | Criterion |
|---|---|---|---|---|
| 1 | `artifact.schema_valid@1.0.0` | 0 | C0 | — (profile-mandatory) |
| 2 | `deps.unchanged@1.0.0` | 1 | C0 | **c1** No dependency manifest change |
| 3 | `locality.confined@1.0.0` | 1 | C0 | **c2** All changes within `src/**` |
| 4 | `api.schema_unchanged@1.0.0` | 1 | C0 | **c3** Public API unchanged |
| 5 | `build.typecheck@1.0.0` | 2 | C1 | **c4** Build and typecheck pass |
| 6 | `tests.affected_pass@1.0.0` | 3 | C1 | **c5** Affected tests pass, quorum `3/3` |

Every criterion binds a `gate_ref` — including the C3 merge approval, which binds `gate://approval.merge@1.0.0` (B1, B9). Five of six criteria are C0/C1, comfortably satisfying the ≥1 rule.

**Exercised gate mechanics:** cost-ascending ordering; **cheap gates exhausted for evidence while expensive stages short-circuit** (Note 03 §10) — so attempt 1's `FailureRecord` carries all of stages 1–2 passing plus the stage-3 failure, not just the first problem; `3/3` quorum with disagreement → `indeterminate`; `error` ≠ `fail` and consumes no attempt.

**Also exercised: a predicate.** `locality.confined` binds `applies_when: artifact.type == CodeDiff` — trivial, but it proves the fact surface, evaluation, and the ZERO_COVERAGE coverage report at policy publication.

---

## 8. Human approval points

**Three, all `1 of 1` quorum:**

1. **Plan approval** — before any node runs. The highest-leverage gate in the design.
2. **Merge approval** — bound to `diff_002`'s content hash. Voids entirely if the content changes.
3. **Role/config publication** — `implementer@1.0.0`, the gate profile, the capability profile, and all four tools each require human registration approval, and the Role additionally requires an `eval_suite` pass (Note 09 §6).

**Not exercised:** quorum > 1 (C3's `N of M` is implemented but unused at `1 of 1`), `approve_with_conditions`, budget-increase approval, memory-commit approval.

---

## 9. Events and instrumentation

**Event families exercised:** unit lifecycle · attempt lifecycle · lease (acquire, renew) · tool (invoked, granted, **denied**) · model (invoked, served) · gate (result recorded, incl. one `fail`) · artifact (constructed → validated → verified → accepted) · approval · budget (reserved, spent, released) · config (spec resolved, tool/gate registered).

**Not exercised but must exist:** escalation, memory, plan supersession, `superseded` attempts.

**Appendix A tier-1 measures, all five live from unit zero** — this is the point of doing them now, since each needs a baseline from nothing:

| # | Measure | Slice-1 expectation |
|---|---|---|
| 1 | Cost per accepted change, per class | One data point for `mechanical_change` |
| 2 | Per-gate catch rate and cost | `tests.affected_pass` catches 1; the other five catch 0 — **and that is the baseline, not a verdict** |
| 3 | Gate `indeterminate_rate` | Expected 0. A non-zero value on slice 1 means a gate is already flaky |
| 4 | Verifier-vs-human disagreement | **N/A — no model verifier.** The sampling harness is built but idle |
| 5 | Rework rate on accepted units | Baseline 0; the denominator starts here |

Plus **denial rate per Role** (measure 7), which slice 1 seeds with exactly one denial.

**Replay is an acceptance criterion, not a nice-to-have** — see §10.

---

## 10. Acceptance criteria for the slice

The slice is done when **all** of these hold:

| # | Criterion | Class |
|---|---|---|
| S1 | An `Intent` produces a validated, human-approved `TaskPlan`, and a plan violating any E1 rule is **rejected pre-dispatch** | C0 |
| S2 | Attempt 1 fails at `tests.affected_pass`, and its `FailureRecord` carries **all** stage 1–2 results plus the stage-3 failure | C1 |
| S3 | Attempt 2 receives the structured `FailureRecord` and **no** narrative from attempt 1 — verified by inspecting the rendered context, not by assertion | C0 |
| S4 | The `net.fetch` denial returns a structured refusal naming granted scopes; the attempt continues; the denial is recorded | C1 |
| S5 | Both `CodeDiff` artifacts are byte-identical to a kernel re-harvest of their preserved workspaces | C0 |
| S6 | **Replay mode 1** reconstructs, for both attempts, exactly what the model saw and every decision made | C0 |
| S7 | **Replay mode 2** recompiles context from pinned sources and reproduces the manifest hash | C0 |
| S8 | Rendered context carries a labelled block with authority tier for every layer, and any truncation is announced | C0 |
| S9 | Budget: spend is decremented at the broker; the failed attempt's cost is retained; reservation is released at terminal state | C0 |
| S10 | Killing the kernel after executor exit and before harvest loses nothing — harvest recomputes identically | C1 |
| S11 | Merge occurs only after an approval bound to the final content hash | C0 |
| S12 | All five tier-1 measures have non-null values | C0 |

**S10 is the one worth building a test harness for.** It is the cheap-crash case Note 06 §9 predicts, and it is the property that most distinguishes this design from one where the executor submits its own artifact.

---

## 11. What this slice deliberately leaves out

| Left out | Why |
|---|---|
| **Architect Role and `ArchitectureDecision`** | Requires constraint compilation and the form vocabulary. Slice 2 |
| **Model verifier / any C2 criterion** | The undrift-testable component (§0). Introduce only once C0/C1 gates are trusted |
| **Planner Role** | Keeps criteria authorship — the system's ceiling — off the first critical path |
| **Multi-node DAG, artifact edges, conflict edges** | One node proves the spine. Slice 2 adds the second node and the first real dependency |
| **Class promotion rules** | No second class to promote to yet |
| **Memory (all five kinds)** | Zero-record instances must compile context successfully; that is the property tested, not memory itself |
| **Instance policy composition** | One instance, one profile of each type. Narrow/Oblige/Bind exist but compose trivially |
| **Escalation and the attention policy** | Nothing should escalate in slice 1. If something does, that is the finding |
| **Quorum > 1, conditional approval** | C3 implemented, exercised at `1 of 1` |
| **Fleet layer, C1/C2b/C4/D7** | Deferred to instance #2 by decision. **The resolver seam is built; nothing above it is** |
| **`RankSpec`, retrieval ranking** | Deferred pending real memory-set sizes |
| **Scheduling priority** | One unit at a time. Admission control exists; priority does not |
| **`constraint_cases` in the eval suite** | They come only from real defects, and there are none yet |

**The honest summary:** slice 1 exercises the spine and every mechanical guarantee, and exercises **none** of the judgement layer. That is deliberate. Every finding that needs data — criteria quality, gate ratcheting, verifier drift — needs the spine running first, and none of them is answerable by building more of the judgement layer up front.

---

*End of Slice 01 proposal.*

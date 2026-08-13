# AI-Org OS — Design Note 09
## Evaluation

**Status:** Draft for review
**Scope:** The minimum `eval_suite` contract that makes Role publication meaningful. **Deliberately narrow.** No scoring frameworks, no benchmark design, no LLM-judge machinery.
**Depends on:** Note 01 §2/§11 (the `eval_suite` field and the publication gate), Note 03 §4/§7/§8 (verdicts, quorum, fixtures), Appendix A (runtime instrumentation).

Note 01 §2 makes `eval_suite` a required field and §11 rule 5 makes it a hard publication gate — *"Publishing requires `eval_suite` to pass and a human to approve. Both, without exception."* §3 calls it "among the most important" fields. Eight notes later, nothing defines what one is. This closes that, and nothing more.

---

## 1. The problem, and the reuse

Role outputs are non-deterministic. You cannot assert on output text, and comparing generated prose to a golden string is a test that fails for the wrong reasons within a week.

**But you can assert on properties of the output — and the system already has a machine for that.**

> **An eval case is a frozen fixture plus a set of expected gate verdicts.
> Run the Role against the fixture, harvest, run the gates, compare verdicts to expectations. No text comparison anywhere.**

This is the third reuse of the same pattern: gates carry fixtures (Note 03 §8), predicates carry fixtures (Note 08 §10), Roles now carry cases. Nothing new is invented.

---

## 2. Schema

```yaml
EvalSuite:
  id, version, owner:  HumanPrincipal
  subject:             RoleId              # the Role this suite tests
  cases:               [EvalCase]
  thresholds:          Thresholds          # §4
  budget_ceiling:      Money               # §7
  quorum:              string              # runs per case, e.g. "3"

EvalCase:
  id
  class:               capability | refusal | constraint      # §3
  fixture:
    repo_snapshot:     CommitRef           # pinned; replayable (Note 02 §14)
    work_unit:         WorkUnitSpec        # objective, criteria, constraints, budget
    input_artifacts:   [ArtifactRef]       # pinned by content hash
  expectation:
    must_pass:         [GateId@SemVer]
    must_fail:         [GateId@SemVer]     # ★ see §3
    terminal_state:    accepted | attempt_failed | escalated
    max_attempts:      int
  origin:              authored | defect_ref   # §5
```

Fixtures are pinned commits and content-hashed artifacts, so a case is replayable under Note 02 §14 modes 1 and 2. A fixture drawn from a mutable source is not admissible, for the same reason no recipe layer may be.

---

## 3. Three case classes

| Class | Asserts | Example |
|---|---|---|
| `capability` | The Role can still do the job | Given a clear spec, the implementer produces a diff that passes its gates |
| `refusal` | The Role does **not** confabulate when it should stop | Given an ambiguous spec, it escalates `spec_ambiguous` rather than producing a confident wrong diff |
| `constraint` | A specific past defect does not recur | The exact `equivalence` constraint a prior version violated |

### Negative expectation is mandatory ★

Every suite must contain at least one `refusal` case. The argument is Note 03 §8's, transplanted: **a suite where everything passes tells you nothing about whether the Role can be wrong.** A Role that never refuses is not a careful Role; it is a Role whose failure mode you have not measured.

`must_fail` inside an expectation carries the same weight — it asserts a gate *does* reject, which is how a `constraint` case proves the defect is actually detected rather than merely absent from this run.

---

## 4. Scoring

### Per case: quorum, reusing Note 03 §7

Each case runs N times. Disagreement across runs yields **`indeterminate`**, never the majority — the identical rule and the identical reason: majority-wins trains everyone to re-run until green.

### Per suite: asymmetric thresholds ★

```yaml
Thresholds:
  constraint_cases:  100%     # absolute
  refusal_cases:     100%     # absolute
  capability_cases:  ≥ 90%    # proportional, suite-configurable
```

The asymmetry is deliberate. A `constraint` case encodes a defect that reached production once; recurrence is not a degradation, it is the same bug shipping twice. A `refusal` case encodes a safety property. Both are absolute.

`capability` is legitimately fuzzy — a model change may trade a small amount of one capability for another, and a human is entitled to accept that. Proportional.

### Suite verdict

Reuses Note 03 §4's vocabulary exactly: `pass` · `fail` · `indeterminate` · `error`.

`error` (the harness broke) is **not** a failure and does not block publication — it means the suite did not run. Same distinction, same reason.

---

## 5. Regression behaviour

> **Every real defect becomes a `constraint` case.**

When a Role version ships a defect that verification catches in production — or worse, that a human catches afterwards — the fixture is captured from the failing unit and added as a `constraint` case with `origin: defect_ref` pointing at the `FailureRecord` or the rework event.

This is the only sanctioned growth path for a suite. It keeps cases tied to observed reality rather than imagined risk, keeps the suite small (§7), and makes the suite an accumulating record of what this Role has actually got wrong.

Authored cases are permitted at suite creation, since a new Role has no defect history. They should be few.

---

## 6. Decision semantics and the human boundary

```
suite pass          → human may approve publication (Note 01 §11 rule 5)
suite indeterminate → publication blocked; re-run or investigate
suite error         → publication blocked; harness fault, not a Role fault
suite fail          → publication blocked by default  ─┐
                                                        │
                              EvalOverride ─────────────┘
```

### The override, and its one hard limit ★

A human **may** publish a Role whose suite fails, via an explicit `EvalOverride` recorded as an `Approval` (Note 02 §12) naming the failing case ids and a stated reason.

This is deliberate. Early on, **eval suites will be wrong more often than Roles are** — a fixture encodes an assumption that a legitimate improvement invalidates. A system that blocked absolutely would be unusable in its first month and would train people to delete inconvenient cases, which is strictly worse than a recorded override.

Consistent with Note 04 §19.1: make weakening **visible, attributable, and versioned** rather than impossible.

**Except:** a failing `constraint` case may **never** be overridden. Overriding one means knowingly republishing a known production defect. There is no reason good enough, and unlike a `capability` threshold there is no judgement call — the case exists because the bug happened.

---

## 7. Triggers and cost

### What runs a suite

| Trigger | Scope | Source |
|---|---|---|
| Role version publication | That Role | Note 01 §11 rule 5 |
| Prompt version change | Roles referencing it | Note 01 §2 |
| Context recipe version change | Roles referencing it | Note 01 §2 |
| **Fleet model binding change** | **Every Role bound to that tier** ★ | A3 |

The last is the trigger Note 01 §3 named the field for: *"You upgrade a model and silently degrade three Roles with no signal."* A tier re-binding must fan out across every Role bound to it, or the field does not do the job it was introduced to do.

### Cost is real

Evals cost `cases × quorum × roles × triggers` in frontier-model calls. A 40-case suite at quorum 3 across five Roles, on every model binding change, is meaningful money.

Three consequences: suites carry a `budget_ceiling`; fixtures should be **small** (narrow repos, single-file units — a fixture is not a demo); and case count grows only from defects (§5). A suite that grows by imagination becomes a tax on every model upgrade, and the first thing a team under pressure will disable.

---

## 8. Publication-time evaluation vs runtime instrumentation

The boundary against Appendix A, since both measure quality and they are not interchangeable.

| | **Eval suite** (this note) | **Appendix A** |
|---|---|---|
| Question | *Is this version safe to publish?* | *Is the running system healthy?* |
| When | Before a version becomes `active` | Continuously |
| Subject | One Role / prompt / recipe / model-binding version | The whole pipeline |
| Data | Frozen fixtures, synthetic, replayable | Real units, real cost, real approvals |
| Decision | Publish or don't | Demote a gate, re-scope a Role, tune a budget |
| Catches | **Regression from a change** | **Drift over time** |

★ **Evals catch regression from a change; instrumentation catches drift over time.** Neither substitutes for the other, and the boundary is simply whether a version changed. A Role that degrades because the world moved will pass every eval and show up only in rework rate (Appendix A measure 5). A Role that degrades because its prompt changed will show up in evals before it ever runs.

One deliberate overlap: **Appendix A measure 5 (rework rate) is the source of `constraint` cases** (§5). Runtime instrumentation feeds publication-time evaluation, in that direction only.

---

## 9. What this is not

| Not in scope | Why |
|---|---|
| **LLM-judge rubric scoring of Role output** | It would be another model gate with the drift problem Note 03 §19.2 cannot solve, judged by a model sharing the subject's blind spots. Expectations are **gate verdicts**, which are mechanical. A C2 gate may appear in an expectation, but the eval asserts *its verdict*, never a score |
| Benchmarks, leaderboards, cross-Role comparison | A suite tests one Role against its own history. Comparing Roles is meaningless — they do different work |
| Golden-output comparison | Non-determinism (§1) |
| Evaluating gates or predicates | They have fixtures already (Note 03 §8, Note 08 §10) |
| Evaluating the instance or the pipeline | Appendix A (§8) |

---

## 10. Invariants

1. **An eval case asserts gate verdicts, never output text.**
2. **Every suite contains at least one `refusal` case.** A suite where everything passes has not measured failure.
3. **Fixtures are pinned and replayable** — content-addressable or version-pinned, per Note 02 §14.
4. **Per-case disagreement across runs is `indeterminate`, never the majority.**
5. **`constraint` and `refusal` thresholds are absolute; `capability` is proportional.**
6. **Every real defect becomes a `constraint` case.** It is the only sanctioned growth path.
7. **A failing suite blocks publication by default; a human may override with a recorded `EvalOverride`.**
8. **A failing `constraint` case may never be overridden.**
9. **A fleet model-binding change triggers evaluation of every Role bound to that tier.**
10. **`error` is not `fail`.** A suite that could not run has not judged anything.
11. **Evaluation is publication-time; Appendix A is runtime.** Instrumentation feeds cases; cases never feed instrumentation.

---

## 11. Deferred

| Item | Why |
|---|---|
| Concrete quorum and threshold values | Need observed variance. `quorum: 3`, `capability ≥ 90%` are placeholders |
| Fixture authoring tooling and capture-from-defect ergonomics | Implementation |
| Suite execution scheduling and parallelism | Note 06 owns execution; a suite run is ordinary WorkUnits |
| Eval suites for `TaskPlan` quality | Would be the criteria-quality gate (Note 02 §17.2) by another name. Still unsolved, still needs data |
| Cross-version capability trend reporting | Useful later; not required to make publication meaningful |

---

*End of Design Note 09.*

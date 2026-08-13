# AI-Org OS — Appendix A
## Instrumentation Register

**Status:** Requirements register. Not a design note — it introduces no architecture.
**Purpose:** Consolidate the measures that Notes 02–08 each assert must exist, into one list with an owner.
**Sources:** Notes 02, 03, 04, 05, 06, 07, 08.

---

## Why this exists

Across eight notes, fifteen separate passages assert that some measure "must exist from day one or the review has no data to look at." **No note owns that list.** A requirement distributed across eight challenge sections does not get built — each note assumes another will carry it, and the measures that most needed a zero baseline are exactly the ones discovered missing six weeks in.

**These are not dashboards.** Each measure exists because a specific note committed to making a specific decision that requires it. The register's third column — *the decision it feeds* — is the reason each row is here. A measure with no decision behind it should be removed.

---

## The register

### Tier 1 — required before the first unit runs

These need a baseline from zero. Starting them later means the first weeks are unmeasurable, and the first weeks are when behaviour is least understood.

| # | Measure | Decision it feeds | Source |
|---|---|---|---|
| 1 | **Cost per accepted change, per `WorkUnitClass`** | Whether the pipeline is economic at all, and whether class pipelines are correctly assigned. ~6–10 model calls per change is defensible at high value and absurd for trivia | Note 03 §17.1 |
| 2 | **Per-gate catch rate** (fails on *real* work) **and cost per run** | Quarterly demotion of zero-catch expensive gates to advisory, and retirement of unread advisories. The only counterweight to the ratchet | Note 03 §15, §19.1 |
| 3 | **Gate `indeterminate_rate`, per gate version** | Whether a gate is degrading. Earliest available signal, and invisible if only pass/fail is recorded | Note 03 §7 |
| 4 | **Verifier-vs-human disagreement, on sampled `pass` verdicts** | Whether the model verifier is drifting toward rubber-stamping. **Sampling failures only cannot detect this** | Note 02 §17.3, Note 03 §19.2 |
| 5 | **Rework rate on accepted units** | The only honest proxy for criteria quality — the system's ceiling (Note 02 §17.2). A well-executed wrong specification passes every gate | Note 02 §17.2 |

### Tier 2 — first month

| # | Measure | Decision it feeds | Source |
|---|---|---|---|
| 6 | **Gate `error_rate`, per gate version** | Separates infrastructure flakiness from work quality. Without it, a flaky runner reads as a bad code generator | Note 03 §4, B2 |
| 7 | **Denial rate, per Role per instance** | Whether repeated denials are a capability-profile defect or a model defect. Only aggregate data distinguishes them | Note 07 §16.2 |
| 8 | **Model fallback rate, per tier** | Explains otherwise-unaccountable behaviour changes when a primary candidate is degraded | Note 07 §14 |
| 9 | **Attempt attrition**: superseded / crashed / budget-exhausted rates | Infrastructure health vs work quality. Also sizes the lease-duration trade-off | Note 06 §16.6 |
| 10 | **Predicate `ZERO_COVERAGE` count** | Whether autonomy guards are still live after refactors. The C5 mechanism | Note 08 §7 |

### Tier 3 — when the relevant subsystem is in use

| # | Measure | Decision it feeds | Source |
|---|---|---|---|
| 11 | **`conformance`-vs-mechanical constraint ratio** | Whether the architecture layer is degrading into prose. A rising ratio means the demotion doctrine is being bypassed via the C2 escape hatch | Note 03 §19.4 |
| 12 | **Memory `unverified` mark frequency, per record** | Which memory records are stale and need review before expiry | Note 05 §8 |
| 13 | **Budget reservation utilisation** (reserved vs actual) | Sizes the cost of pessimistic reservation, and whether ceilings are set far above real spend | Note 06 §16.2 |
| 14 | **Escalation rate and open-escalation duration, per principal** | Whether the human gate is degrading under load. Aggregated across instances, per C1 | Note 04 §11, C1 |
| 15 | **Context truncation frequency, per recipe layer** | Which recipes are over-subscribed and which layer caps are wrong | Note 01 §14, E2 |

---

## Two rules for reading these ★

### 1. Never report an efficiency measure without its paired quality measure

Every efficiency measure here can be improved by degrading quality, and the degradation is invisible in the efficiency number.

| Efficiency measure | Must always be read with |
|---|---|
| 1 — cost per accepted change | 5 — rework rate |
| 2 — gate cost per run | 2 — gate catch rate |
| 9 — attempt attrition | 6 — gate error rate |
| 13 — reservation utilisation | budget exhaustion count |

"Cost per accepted change fell 30%" is not a result. Paired with a rising rework rate it is a warning that the pipeline is accepting weaker work more cheaply.

### 2. Measure the system, not the model

Every measure here is a property of **the pipeline**, computed by deterministic code over the event stream (Note 06 §11). None is self-reported by an agent, and none should be. Note 01's `self_report_accepted: false` applies to metrics exactly as it applies to verdicts: a metered party does not report its own meter (Note 07 §8).

---

## Provenance

All fifteen are projections over the event stream (Note 06 §11) — no new capture is required. The event families that carry them:

| Measure | Event family |
|---|---|
| 1, 13 | Budget (reserved, spent, released) + unit lifecycle |
| 2, 3, 6, 11 | Gate (result recorded, with verdict and cost) |
| 4 | Gate + approval + a sampling job |
| 5 | Unit lifecycle + artifact supersession over time |
| 7 | Tool (denied) |
| 8 | Model (served, with `model_served`) |
| 9 | Attempt lifecycle + lease |
| 10 | Config (policy published) + repository-change hook |
| 12 | Context manifest (memory layer marks) |
| 14 | Escalation + approval |
| 15 | Context manifest (truncations) |

**Measure 4 is the only one requiring work beyond a projection** — it needs a sampling job that surfaces a percentage of `pass` verdicts for human review, and a place to record the human's agreement or disagreement. It is also the only instrument available for Note 02 §17.3, which has no other answer, so the extra work is not optional.

---

## What is deliberately absent

| Not measured | Why |
|---|---|
| Per-Role "success rate" | Note 01 §4: derived data on config invites the system to self-modify against its own scorecard |
| Agent-reported confidence | Note 01 §7, Note 05 §3: poorly calibrated, and reads as evidence |
| Velocity, throughput, story points | Human-org metrics with no mechanical meaning here |
| Anything computed from `private` segments | Note 03 §5's visibility ceiling. An `audit_only` gate may read them and report only to humans |
| Cross-instance aggregates | Note 04 §13. Exception: C1's principal attention budget, which aggregates *per principal* and is the sole legitimate case |

---

*End of Appendix A.*

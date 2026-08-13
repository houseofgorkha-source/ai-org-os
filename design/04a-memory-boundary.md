# AI-Org OS — Boundary Proposal 04a
## The Memory Subsystem: Scope and Exclusions

**Status:** Boundary proposal. Not a design note. Note 05 not yet written.
**Source of truth:** Notes 01–04 and accepted amendments A1–A11 / B1–B8.
**Constraint:** No storage technology, no retrieval mechanism, no implementation.

---

## Headline finding

**Notes 02–04 absorbed almost everything Note 01 called "memory."** The artifact system took decisions, the event log took execution history, the repository remained ground truth, and policy took governance. What is left for Memory is a small residue — and shrinking it is the correct outcome, not a loss.

Measured against the original vision document's five memory types:

| Vision doc type | Verdict | Actual home |
|---|---|---|
| Company Memory | **survives** | Memory |
| Project Memory | **survives, narrowed** | Memory (standing objectives only) |
| Decision Memory | **not memory** | `ArchitectureDecision` artifacts (Note 02 §4) |
| Execution Memory | **not memory** | `Attempt` + event log (Note 02 §6, §14) |
| Agent Memory | **does not exist** | Roles hold no state (Note 01 §4, §16) |

Two of five survive. Any design that re-expands this is re-importing state into a system that deliberately removed it.

---

## The defining rule

> **Memory informs. It never constrains.**
>
> Memory may only ever be an input to **context assembly**. It is never an input to validation, gating, capability resolution, or budget enforcement.

This is not a precedence rule. It is a **reachability** rule: the Context Compiler reads Memory; the kernel validator, the gate runner, and the capability broker have no path to it. Memory cannot override anything because it never enters the code paths where overriding would be possible.

The practical test for any candidate fact:

| If you want it… | It belongs in… |
|---|---|
| **enforced** | Policy (Note 04) or a Gate (Note 03) |
| **contractual for one task** | The `WorkUnit` contract or an `ArchitectureDecision` constraint |
| **true right now** | The repository — read live, never remembered |
| **on the record** | Artifacts and the event log |
| **merely considered** | **Memory** |

---

## 1. What is legitimately Memory

Durable, non-derivable context that informs how work is specified, and constrains nothing.

| Kind | Example | Why it cannot live elsewhere |
|---|---|---|
| `knowledge` | "The core domain entity is a Shipment; customers are 3PLs, not carriers." | Not in the repo except implicitly; not produced by any work unit; constrains nothing |
| `objective` | "Reduce onboarding to under 5 minutes this quarter." | A standing goal, not a one-shot `Intent`. Informs planning and criteria authorship |
| `heuristic` | "The payments module has weak test isolation; prefer integration tests there." | A generalisation from experience. **The dangerous kind** — see §5–6 |
| `reference` | "Design system lives at ‹URL›; ticketing at ‹URL›." | External pointers, not artifacts |
| `preference` | "Prefer small, single-purpose changes over batched ones." | Human working preference, unenforced. If it must be enforced, it is policy |

**Common property:** human-authored or human-approved, non-derivable from live sources, and *advisory in every case*.

---

## 2. What stays in the repository / artifact system

| Information | Home | Authority |
|---|---|---|
| Code, structure, signatures, file locations, dependencies | **Repository**, read live | Note 01 §6 — memory duplicating the repo is a bug factory |
| Architecture decisions and their `constraints[]` | **`ArchitectureDecision` artifacts** | Note 02 §4. Memory offers no provenance, immutability, supersession, or constraint compilation (Note 03 §12) |
| Diffs, verification reports, plans | **Artifacts** | Note 02 §4 |
| Interface contracts, schemas, DDL | **Repository** | Note 01 §12 |
| Prior attempts' failure evidence | **`FailureRecord`** on the `Attempt` | Note 02 §11. Never generalised into Memory without human approval |

**Rule:** if it has provenance and a content hash today, it is an artifact. Copying it into Memory creates a second copy that drifts and has no hash.

---

## 3. What belongs in Policy

Everything that **constrains**. Note 04 §18's boundary, restated as a test: *policy constrains, memory informs.*

| Information | Home |
|---|---|
| Capability, permission, egress, tier caps | Policy — Narrow (Note 04 §5) |
| Mandatory gates, required approvals, forced criteria | Policy — Oblige (Note 04 §6) |
| Repository, environment, secret scope, approver bindings | Policy — Bind (Note 04 §7) |
| Which Roles may appear in plans | Policy — admission (Note 04 §8) |
| Budgets, concurrency, attention limits | Policy (Note 04 §10, §11) |
| Retention horizons, config channel | Policy (Note 04 §12, §15) |

**The sharpest case:** "always require 90% test coverage" is **policy** (`criteria_obligations`), not memory. If it were memory, an advisory input would be silently gating work — the exact violation the defining rule prevents.

---

## 4. What belongs in immutable execution history

| Information | Home |
|---|---|
| What ran, what it saw, what it cost | `Attempt` (Note 02 §6) |
| Exactly what the model saw | `ContextManifest` (Note 01 §14) |
| Gate verdicts and evidence | `GateResult` (Note 03 §5) |
| Approvals | `Approval` artifacts (Note 02 §12) |
| Reasoning traces | `Attempt.raw_trace_ref`, **`private`** (Note 02 §6) |
| Success rates, cost, throughput, verifier disagreement | **Projections** over the event log (Note 01 §4) |

**Rule:** history is append-only fact about *what happened*. Memory is durable belief about *what is true*. A summary of history is not history — and turning one into the other requires §6's gate.

---

## 5. What an agent may write to Memory

> **Nothing. There is no unattended agent write path to Memory, at any tier, under any policy.**

An agent may emit a **`MemoryProposal` artifact** — typed, evidence-bearing, with full provenance — produced by a WorkUnit like any other artifact. It then passes through the ordinary pipeline:

```
WorkUnit → MemoryProposal artifact → gates → human Approval → committed MemoryRecord
```

There is no privileged mutation channel. Memory writes use the same machinery as code changes because there is no reason they should be easier, and one strong reason they should not: a wrong heuristic promoted to durable Memory poisons every future context silently, and unlike a bad diff, nothing downstream will ever fail because of it.

**Derived requirement (Note 02 §14):** Memory is a context source, and every context source must be content-addressable or version-pinned. Therefore **`MemoryRecord`s are immutable and versioned**, superseded rather than edited. This is forced, not chosen — mutable memory breaks replay modes 1 and 2.

---

## 6. What requires human approval

**All of it.** The tiers differ in the *bar*, not in whether a human is involved.

| Kind | Bar | Expiry |
|---|---|---|
| `heuristic` | Strictest. Named approver, evidence refs required, scope must be explicit | **Mandatory** ★ |
| `objective` | Approval by the instance owner | Mandatory (period-bound by nature) |
| `knowledge` | Approval; evidence optional if human-asserted | Review horizon, no hard expiry |
| `reference` | Approval; cheap | Review horizon |
| `preference` | Approval by the principal it describes | Review horizon |

★ **Every heuristic carries a mandatory expiry.** A heuristic is a generalisation from limited evidence and has a shelf life. Expiry forces periodic re-justification and is the only mechanism that reliably removes stale ones — nobody ever proactively deletes a memory, and a stale heuristic degrades every context it enters without ever producing a failure that points at it.

**No numeric confidence field.** Note 01 §7 established that model confidence is poorly calibrated and reads as evidence. Memory carries `evidence[]` — references to the artifacts or events that justify it — or is explicitly marked human-asserted. A number would be worse than nothing.

**Memory approvals must be non-blocking** (see §10, D4). An unreviewed `MemoryProposal` simply never becomes Memory. Nothing stalls, nothing escalates, and no dispatch pause is triggered — otherwise Memory becomes a generator of attention-budget pressure against the limits in Note 04 §11.

---

## 7. Can Memory override anything?

**No — and not by rule, by construction.**

| Target | Can Memory override it? | Why not |
|---|---|---|
| Repository state | No | Memory is never consulted for ground truth; recipes read the repo live |
| `WorkUnit` contract | No | Contracts are immutable after validation (Note 02 §1) and Memory has no write path to them |
| Policy | No | Policy is composed from Fleet/Instance/Unit (Note 04 §2). Memory is not a layer in that lattice |
| Gates | No | **Gates may not read Memory.** `Gate.requires_context` (Note 03 §2) has no memory source, and must never gain one (D3) |
| Criteria | No | Criteria bind to gates (Note 03 §11). A criterion sourced from Memory would make advisory content gating |
| Capabilities / budgets | No | Resolved in `ResolvedExecutionSpec` before any context exists (Note 02 §7) |

Memory reaches exactly one component: the **Context Compiler**, as one low-priority recipe layer.

---

## 8. Precedence on conflict

Within the only path Memory reaches — context assembly — precedence is strict:

```
1. Live repository state          (ground truth)
2. Pinned input artifacts         (the contract for this unit)
3. Policy-derived facts           (bindings, obligations)
4. Memory                         (advisory, lowest)
```

**Conflicting Memory is dropped and flagged, never merged.** Silent merge produces context that is internally inconsistent and impossible to debug.

The flag is the valuable half. Mechanism, without storage implications:

- Every `MemoryRecord` carries **`asserted_against`** — the repo commit, artifact id, or policy version it was true against.
- At compile time, if the referenced thing has changed, the record is marked **`unverified`** in the `ContextManifest` rather than presented as fact.
- Repeated `unverified` marks are the staleness signal that triggers human review.

This makes staleness *detectable and cheap* rather than discovered when a decision goes wrong.

---

## 9. Minimum primitives

Model only — no storage, no retrieval mechanism.

**Records** (two types)

```
MemoryProposal    — an Artifact. Produced by a WorkUnit. Not yet Memory.
MemoryRecord      — committed, immutable, versioned.
    id · instance_id · version
    kind             knowledge | objective | heuristic | reference | preference
    statement        the content
    scope            what it applies to (subsystem, path, domain)
    asserted_against repo commit / artifact / policy version  (§8)
    evidence[]       refs justifying it, or explicit human_asserted
    provenance       proposing work unit + approving human + approval ref
    status           active | superseded | expired | retracted
    expires_at       mandatory for heuristic
    supersedes
```

**Operations** (six)

| Operation | Actor | Notes |
|---|---|---|
| `propose` | Agent (as an artifact) | The only agent-reachable operation |
| `commit` | Human approval → kernel | Turns a proposal into a record |
| `retrieve` | Context Compiler only | One recipe layer, budgeted, lowest priority |
| `supersede` | Human-approved new version | Lineage preserved |
| `retract` | Human | Marks wrong. **Never deletes** — replay requires the record |
| `expire` | Kernel, automatic | By `expires_at`. Mandatory for heuristics |

**Invariants**

1. Records are immutable and versioned (forced by Note 02 §14).
2. Nothing is deleted; retraction and expiry are status changes.
3. Retrieval is scoped to one instance. **No field in a `MemoryRecord` may name another instance** (Note 04 §13).
4. Memory is reachable only from the Context Compiler.
5. Every record traces to an `Approval`.

---

## 10. Contradictions with Notes 01–04, and required amendments

| # | Contradiction | Resolution |
|---|---|---|
| **D1** | **Note 01 §6 defines four memory types** — ground truth, decision log, execution traces, learned heuristics. Under Notes 02–04, three of the four are not Memory: ground truth is the repository, decisions are artifacts, traces are the event log. **Direct contradiction.** | Amend Note 01 §6 to the five kinds in §1, and state where the other three went. |
| **D2** | **Recipes have no memory layer.** Notes 01 §12/§13 exclude "unapproved learned heuristics," implying approved ones are included — but no recipe defines a memory layer, budget, or priority. **Gap.** | Add an explicit `memory` layer to the recipes: lowest priority, hard token cap, subject to §8 precedence, `on_miss: omit`. |
| **D3** | **Gate memory access is unstated.** Note 03 §2 `requires_context` omits memory by accident rather than by rule. Silence is not a prohibition. | State explicitly: `Gate.requires_context` may never include a memory source. Enforced at gate registration. |
| **D4** | **Memory approvals would consume attention budget.** Note 02 §12 requires a human for every `Approval`; Note 04 §11 / C1 pause dispatch when pending approvals breach the principal's budget. Memory proposals would throttle real work. | Memory-commit approvals are **non-blocking** and excluded from the attention pause calculation. An unreviewed proposal simply never becomes Memory. |
| **D5** | **Memory immutability is implied, not stated.** Note 02 §14 requires every context source to be content-addressable or version-pinned; nothing says Memory satisfies this. | State it as a derived requirement: `MemoryRecord`s are immutable and versioned. Mutable Memory breaks replay modes 1 and 2. |

**No contradiction found with:** Note 01 §4 and §16 (no Role memory), Note 02 §12 (human-only approvals), Note 04 §13 (no cross-instance reference), Note 04 §18 (governance/knowledge boundary — this proposal confirms and sharpens it).

---

## What Note 05 would still have to decide

Deliberately out of scope here: the retrieval model (how `scope` selects records for a recipe layer), the `MemoryProposal` gate set, staleness-review workflow, expiry defaults per kind, and whether `objective` should instead be modelled as a long-lived `Intent` rather than a memory kind. That last one is a genuine open question and the only place I am unsure of the boundary.

---

*End of Boundary Proposal 04a.*

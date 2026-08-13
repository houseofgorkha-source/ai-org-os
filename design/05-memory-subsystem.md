# AI-Org OS — Design Note 05
## The Memory Subsystem

**Status:** Draft for review
**Scope:** Conceptual architecture of Memory. No storage technology, no retrieval algorithms, no embeddings.
**Depends on:** Notes 01–04, accepted amendments A1–A11 / B1–B8, Boundary Proposal 04a
**Amendments:** D1–D5 already in `AMENDMENTS-pending.md` from 04a. D6–D7 added by this note. Notes 01–04 untouched.

---

## The central invariant

> **Memory informs. It never constrains.**

Memory may influence **Context Assembly** and nothing else. It has no path — not a restricted path, not a privileged path, no path — to validation, gating, capability resolution, permission enforcement, budget enforcement, policy composition, repository ground truth, or `WorkUnit` contracts.

This is enforced by **reachability**, not by policy. §7 defines the mechanism.

---

## Table of contents

1. [Purpose and scope](#1-purpose-and-scope)
2. [Memory taxonomy](#2-memory-taxonomy)
3. [`MemoryRecord`](#3-memoryrecord)
4. [`MemoryProposal`](#4-memoryproposal)
5. [Lifecycle](#5-lifecycle)
6. [Human approval](#6-human-approval)
7. [The retrieval boundary](#7-the-retrieval-boundary)
8. [Context integration](#8-context-integration)
9. [Scope and isolation](#9-scope-and-isolation)
10. [Memory safety](#10-memory-safety)
11. [Memory gates](#11-memory-gates)
12. [Operations](#12-operations)
13. [Replay implications](#13-replay-implications)
14. [Contradictions and amendments](#14-contradictions-and-amendments)
15. [Open questions](#15-open-questions)
16. [Worked example](#16-worked-example)
17. [Architectural invariants](#17-architectural-invariants)

---

## 1. Purpose and scope

### What Memory owns

Durable, human-approved, non-derivable context that informs **how work is specified and executed**, and constrains nothing.

Memory exists because a class of fact is simultaneously: not present in the repository, not produced by any WorkUnit, not a governance constraint, and not a record of what happened — yet materially improves the quality of design and implementation when present in context. *"Customers are 3PLs, not carriers"* changes what an architect designs and appears in none of the other durable stores — not the repository, not an artifact, not the event log, not policy.

### What Memory explicitly does not own

| Not owned | Actual home | Established by |
|---|---|---|
| Code, structure, signatures, file locations | **Repository**, read live | Note 01 §6 |
| Architecture decisions and their `constraints[]` | `ArchitectureDecision` artifacts | Note 02 §4 |
| Diffs, verification reports, plans, approvals | Artifacts | Note 02 §4, §12 |
| What ran, what it saw, what it cost | `Attempt` + event log | Note 02 §6, §14 |
| Reasoning traces | `Attempt.raw_trace_ref`, `private` | Note 02 §6 |
| Gate verdicts and evidence | `GateResult` | Note 03 §5 |
| Capabilities, permissions, budgets, obligations, bindings | Policy | Note 04 |
| Role definitions, prompts, recipes, gates | Shared OS config | Notes 01, 03 |
| Success rates, cost, throughput, disagreement rates | Projections over the event log | Note 01 §4 |
| Per-Role or per-agent state | **Does not exist** | Note 01 §4, §16 |

### The disposition test ★

The sharpest boundary against the most likely error — duplicating the repository:

> **Memory may describe *disposition*, *meaning*, and *intent*.
> It may never describe *structure*.**

| Admissible (disposition / meaning) | Inadmissible (structure) |
|---|---|
| "The payments module has weak test isolation." | "`PaymentService` lives in `src/payments/service.ts`." |
| "A Shipment is the core domain entity; customers are 3PLs." | "`Shipment` has 14 fields including `carrier_id`." |
| "Onboarding friction is our current strategic concern." | "The onboarding flow has 5 steps." |

Structure changes and the repository is authoritative. Disposition is a judgement about structure that the structure itself does not record. This test is enforced by a gate (§11).

---

## 2. Memory taxonomy

Five kinds. The taxonomy is closed: adding a kind is a design change, not configuration.

### 2.1 `knowledge`

| Dimension | Definition |
|---|---|
| **Meaning** | Durable domain, product, or organisational fact that shapes design |
| **Examples** | "Customers are 3PLs, not carriers." · "Shipment is the core aggregate; everything else references it." · "We serve EU customers, so data residency is a live concern." |
| **Scope** | Usually `org` or `domain`; occasionally `subsystem` |
| **Approval** | Instance owner or delegate. Evidence optional if `human_asserted` |
| **Expiry** | No hard expiry. **Review horizon** (default 12 months) |
| **Enters context** | Yes — architecture and implementation recipes |
| **Supersedable** | Yes |

### 2.2 `objective`

| Dimension | Definition |
|---|---|
| **Meaning** | A standing goal that **frames** work without requesting it |
| **Examples** | "Reduce onboarding to under 5 minutes this quarter." · "Reduce p99 latency on the read path." |
| **Scope** | `org` or `project` |
| **Approval** | **Instance owner only.** Not delegable |
| **Expiry** | **Mandatory.** Time-bound by nature |
| **Enters context** | Yes — architecture and planning recipes. **Not** implementation (too coarse to be actionable at that altitude, and it invites scope creep) |
| **Supersedable** | Yes |

### 2.3 `heuristic`

| Dimension | Definition |
|---|---|
| **Meaning** | A generalisation from experience about how to work in a given scope |
| **Examples** | "The payments module has weak test isolation; prefer integration tests there." · "Migrations in this codebase have historically needed a two-phase rollout." |
| **Scope** | `subsystem` or `path`. **Never `org`** — an org-wide heuristic is either policy or knowledge, misfiled |
| **Approval** | **Strictest.** Named approver, `evidence[]` **required**, explicit scope required |
| **Expiry** | **Mandatory.** Default 90 days |
| **Enters context** | Yes — architecture and implementation recipes |
| **Supersedable** | Yes, and frequently should be |

Heuristics are the memory-poisoning vector and carry the tightest controls throughout this note.

### 2.4 `reference`

| Dimension | Definition |
|---|---|
| **Meaning** | A pointer to an external resource |
| **Examples** | "Design system: ‹URL›." · "Ticketing: ‹URL›." |
| **Scope** | `org` or `domain` |
| **Approval** | Instance owner or delegate. Cheap |
| **Expiry** | Review horizon (default 12 months) |
| **Enters context** | Yes — **as a pointer only.** The OS never fetches it (Note 02 §14: a live external source is not an admissible context layer) |
| **Supersedable** | Yes |

### 2.5 `preference`

| Dimension | Definition |
|---|---|
| **Meaning** | A human working preference, advisory, unenforced |
| **Examples** | "Prefer small single-purpose changes over batched ones." · "Prefer explicit over clever." |
| **Scope** | `org`, or scoped to the principal it describes |
| **Approval** | The principal it describes |
| **Expiry** | Review horizon |
| **Enters context** | Yes — implementation and architecture recipes |
| **Supersedable** | Yes |

**If a preference must be enforced, it is not a preference.** "All changes must touch ≤5 files" is `criteria_obligations` in policy (Note 04 §6). The moment a preference gates work it has left Memory.

---

### 2.6 Resolving 04a's open question: `objective` — Memory or long-lived `Intent`?

**Decision: `objective` remains a Memory kind. It is not an `Intent`.**

The distinguishing test is not authorship or durability — both are human-originated and both persist. It is **whose context it enters**:

> An `Intent` enters the context of **the work it spawned**, via `intent_ref` lineage (Note 02 §2).
> An `objective` must enter the context of **work it did not spawn**.

That asymmetry is decisive. The entire value of "we are optimising onboarding this quarter" is that it reaches an architect working on an unrelated authentication change. `Intent` has no mechanism for this and should not grow one — `intent_ref` is a lineage pointer, and making it a broadcast channel would destroy the one query it exists to serve ("everything that came from this request").

Three further reasons:

1. **Intents terminate; objectives frame.** An Intent reaches a terminal state when its plan completes. An objective is still true afterwards and continues to inform.
2. **Objectives spawn nothing.** They have no plan, no DAG, no budget, no completion condition. Modelling them as Intents would create Intents that never close, polluting every lineage query and every "open work" projection.
3. **Objectives are advisory.** An Intent demands a response; an objective does not. That is exactly the informs/constrains split this note is built on.

**The bright line, mechanically checkable:**

> **An `objective` may inform work. It may never spawn work.**
> A `MemoryRecord` of kind `objective` appearing as any `WorkUnit.intent_ref` is a **kernel validation failure**.

Without that check, `objective` becomes a backdoor Intent that bypasses plan approval — work appearing with no human-approved plan behind it, justified by a memory record. The check is cheap and static.

**The residual risk, named:** `objective` is the kind most likely to be used to constrain. *"We're optimising onboarding, so reject anything that adds friction"* is a **criterion**, and it belongs in policy. Objectives therefore carry the strictest scope discipline and the mandatory expiry, and §11's gate set rejects objective statements phrased as requirements ("must", "may not", "shall").

---

## 3. `MemoryRecord`

```yaml
MemoryRecord:

  # ---- IDENTITY -------------------------------------------------------
  id:              MemoryId
  instance_id:     InstanceId
  version:         SemVer
  content_hash:    Hash

  # ---- CLASSIFICATION -------------------------------------------------
  kind:            knowledge | objective | heuristic | reference | preference
  statement:       string
  scope:           ScopeSpec              # §9

  # ---- GROUNDING ------------------------------------------------------
  asserted_against:
    repo_commit:   CommitRef?
    artifacts:     [ArtifactId]?
    policy_version: PolicyRef?
  evidence:
    - kind:        artifact | event | gate_result | human_assertion
      ref:         Ref?                   # instance-local, content-addressed
      note:        string?

  # ---- PROVENANCE -----------------------------------------------------
  provenance:
    proposal_id:   ArtifactId             # the MemoryProposal it came from
    proposed_by:   Principal              # human | role_ref (via a WorkUnit)
    work_unit_id:  WorkUnitId?
    approved_by:   HumanPrincipal         # NEVER a role, never the kernel
    approval_ref:  ApprovalId
    committed_at:  timestamp

  # ---- LIFECYCLE ------------------------------------------------------
  status:          active | superseded | expired | retracted
  effective_from:  timestamp
  expires_at:      timestamp?             # MANDATORY for heuristic, objective
  review_by:       timestamp?             # for kinds without hard expiry
  supersedes:      MemoryId@SemVer?
  superseded_by:   MemoryId@SemVer?
  retraction:
    reason:        string
    by:            HumanPrincipal
    at:            timestamp
```

### Field rationale

| Field | Why it exists | What breaks without it |
|---|---|---|
| `id` + `version` | Stable identity across supersession | Replay cannot determine which text was in context |
| `content_hash` | Content addressing | Note 02 §14 requires every context source to be content-addressable. Without it Memory is an inadmissible layer |
| `kind` | Drives approval bar, expiry, and which recipes may retrieve it | Every record gets the loosest possible handling |
| `statement` | The content | — |
| `scope` | Determines retrieval eligibility | Records leak into unrelated work; the store becomes noise |
| `asserted_against` | ★ The staleness mechanism (§8) | Stale memory is presented as current fact and is undetectable until a decision goes wrong |
| `evidence` | Justification, and the anti-guess control (§10) | Agents promote plausible inference into durable belief |
| `provenance` | Attribution to a proposal, a proposer, and an approving human | Forensic replay cannot answer "who decided this was true" |
| `status` | Lifecycle without deletion | — |
| `expires_at` | ★ Forced obsolescence for generalisations | Nobody proactively deletes memory; the store silently rots |
| `supersedes` / `superseded_by` | Lineage across corrections | The history of a belief is unreconstructible |
| `retraction` | Marks a record wrong **without deleting it** | Replay of the period when it was active becomes impossible |

### Required properties

1. **Immutable.** Content and hash fixed at commit. Corrections create a new version with `supersedes`.
2. **Versioned.** Semver; a changed `statement` is always a new version, never an edit.
3. **Content-addressable.** Forced by Note 02 §14, not chosen.
4. **Instance-scoped.** `instance_id` is fixed at creation and there is no field naming another instance (§9).
5. **Non-deletable.** `retracted` and `expired` are statuses. Deletion would break replay of every execution that saw the record (Note 02 §14).

### No confidence field ★

`MemoryRecord` carries **no numeric confidence**. Note 01 §7 established that model confidence is poorly calibrated, and a number in a context window reads as evidence regardless of its provenance. Justification is expressed as `evidence[]` — resolvable references — or explicitly as `human_assertion`. A record's weight is a function of what backs it, not of a self-report.

---

## 4. `MemoryProposal`

**A `MemoryProposal` is an Artifact** (Note 02 §4) in every respect: immutable, content-hashed, produced by a `WorkUnit`, carrying segments with visibility classes (Note 02 §5). It is not a special object with a private write path.

```yaml
Artifact:
  type: MemoryProposal
  schema_ref: "schema://memory_proposal/1.0.0"
  segments:
    - name: proposed_record   visibility: public
        # kind, statement, scope, asserted_against, expires_at, supersedes
    - name: evidence          visibility: public
        # resolvable instance-local refs
    - name: justification     visibility: restricted
        # why the proposer believes this generalises
    - name: reasoning_trace   visibility: private
        # UNREACHABLE by any gate or context, always
```

### Required evidence, by proposer ★

> **Humans may assert. Agents must evidence.**

| Proposer | `evidence[]` requirement |
|---|---|
| Human principal | May be `human_assertion` with no refs. Recorded as such, and contexts can weight it accordingly |
| Agent (via a WorkUnit) | **At least one resolvable, instance-local ref** to an artifact, event, or gate result. A proposal with no refs is rejected at the gate |

The asymmetry is the point. A human asserting a domain fact is exercising authority they legitimately hold. An agent asserting a generalisation is producing an inference, and an inference without a citation is a guess — which is precisely the artefact that must never become durable.

### Required provenance

Carried from the producing `WorkUnit` per Note 02 §4: `work_unit_id`, `attempt_id`, `role_ref`, `execution_spec_hash`, `context_manifest_ref`, `inputs_hash`. Every committed record is therefore traceable to the exact context that produced the proposal — which is how you investigate a memory that turned out to be wrong.

### Lifecycle position

A `MemoryProposal` that is never approved remains at `status: verified` indefinitely. It never becomes Memory, nothing stalls, and no escalation is raised (§6).

---

## 5. Lifecycle

```
   propose ──► review ──► approve ──► commit ──► active
      │           │          │                     │
      │           │          └── reject ──► closed │
      │           └── gate fail ──► closed         │
      │                                            │
      └── (proposal remains `verified` forever if never reviewed)
                                                   │
                        ┌──────────────────────────┼──────────────────────┐
                        ▼                          ▼                      ▼
                    supersede                   expire                 retract
                  (new version)          (automatic, by date)    (human, marks wrong)
                        │                          │                      │
                        ▼                          ▼                      ▼
                   `superseded`               `expired`             `retracted`
```

### Transitions and authorisation

| Transition | Actor | Authorisation | Notes |
|---|---|---|---|
| `propose` | Agent (via WorkUnit) or human | Role admitted (Note 04 §8); any human principal | Produces an Artifact, nothing more |
| `review` | Memory gates | Gate profile (§11) | Deterministic gates first, per Note 03 §10 |
| `approve` | **Human only** | Per §2 approval bar by kind | Note 02 §12: only a human principal creates an `Approval` |
| `reject` | Human, or a blocking gate `fail` | — | Proposal closes; no record created |
| `commit` | **Kernel** | Requires a valid `Approval` bound to the proposal's content hash | Kernel-only; no other actor may create a `MemoryRecord` |
| `supersede` | Human approval of a new proposal declaring `supersedes` | Same bar as the kind | Old record → `superseded`; both retained |
| `expire` | **Kernel, automatic** | `expires_at` reached | No human action; record leaves context immediately |
| `retract` | **Human only** | Instance owner | Marks wrong. Never deletes |

**No transition returns a record to `active`.** A retracted or expired belief that turns out to be right is re-proposed as a new record with new evidence — which forces re-justification rather than silent reinstatement.

---

## 6. Human approval

**Every durable Memory write requires a human approval bound to the proposal's content hash.** All Note 02 §12 invariants apply unchanged: only a human principal may create an `Approval`; the approval binds to a content hash and is void if content changes; `one_time` is the default scope.

The approval bar varies by kind (§2). Nothing varies about whether a human is involved.

### The non-blocking rule ★

> **Memory approvals are non-blocking. They do not pause dispatch, do not raise escalations, and do not count toward the principal attention budget's pause calculation** (Note 04 §11, amendment C1).

Three reasons, in order of weight:

1. **Advisory input must not throttle authoritative work.** Memory is the only subsystem whose absence costs nothing — an instance with zero memory produces correct, verified, fully governed work. Letting an unreviewed advisory proposal pause an implementation unit would invert the value ordering of the entire system.
2. **It would create rubber-stamping pressure.** Note 02 §13 established that the human gate degrades under load and that a rubber-stamped gate is worse than no gate. Memory proposals are high-volume and low-individual-stakes — exactly the traffic that trains a human to approve without reading. Once that reflex forms it does not stay confined to memory approvals, and the merge gate is next.
3. **The failure mode of not approving is benign.** An unreviewed proposal simply never becomes Memory. Compare with an unreviewed merge approval, where the work is done and blocked. There is no pressure to resolve, so there should be no mechanism that creates it.

**Consequences:** memory approvals are batched, presented on the reviewer's schedule, and have no SLA. A proposal may sit indefinitely. This is correct behaviour, not a queue to be drained.

---

## 7. The retrieval boundary

### The only permitted path

```
   MemoryRecord (active, in scope)
            │
            ▼
   CONTEXT COMPILER          ← the single consumer, no exceptions
            │
            ▼
   Context Recipe `memory` layer
            │
            ▼
   Assembled context for ONE WorkUnit attempt
```

### Forbidden consumers — architectural invariants

| Component | May read Memory? | Consequence if it could |
|---|---|---|
| **Gates** (Note 03) | **No** | Advisory content would enter the enforcement path; a memory record would gate work |
| **Capability Broker** (Note 01 §6) | **No** | Capability resolution would depend on unversioned advisory belief |
| **Kernel validation** (Note 02 §9) | **No** | Validation would stop being deterministic and pre-execution |
| **Policy composition** (Note 04 §2) | **No** | Memory would become a lattice layer, defeating the direction invariant |
| **Budget enforcement** (Note 02 §8) | **No** | Cost control would depend on advisory content |
| **`ResolvedExecutionSpec` resolution** (Note 02 §7) | **No** | The spec must be resolvable before any context exists |
| **Context Compiler** (Note 01 §14) | **Yes — sole consumer** | — |

### How this is enforced ★

Not by rule, by **disjoint enumeration**.

Memory is exposed through a `SourceId` that is registered **exclusively** for Context Compiler layer resolution. Gates declare their inputs from `Gate.requires_context` (Note 03 §2), whose enumeration is `workspace_snapshot | baseline_artifact | constraint_refs | runtime_environment` — a set that contains no memory source and, per amendment D3, may never gain one. The two enumerations are disjoint by construction, and gate registration (Note 03 §8) rejects any gate declaring a source outside its enumeration.

The capability broker, kernel validator, and policy composer take no context sources at all; they read config and artifacts. There is no field through which memory could be supplied to them.

**This is the same structural move as Note 01 §10's absent `delegates_to` and Note 04 §13's absent cross-instance field: the guarantee holds because the channel does not exist, not because a rule forbids using it.**

---

## 8. Context integration

### Memory as a recipe layer

```yaml
- name:       memory
  source:     memory_store            # the exclusive SourceId of §7
  selector:   scope_match(work_unit.scope) AND status == active
  priority:   5                       # LOW — never 1
  max_tokens: 3000                    # hard cap
  required:   false
  on_miss:    omit
  transform:  memory_render
```

Three constraints, each derived rather than chosen:

1. **`priority` must never be 1.** Note 01 §14 states priority 1 is never truncated. **Memory must always be the first thing truncated** when a context exceeds budget. Advisory content may never displace the objective, the governing decision, or the target files.
2. **`required: false`, `on_miss: omit`.** An instance with empty Memory must compile context successfully. A required memory layer would make a new instance unable to run at all.
3. **Hard `max_tokens` cap.** Memory is the layer that grows without bound as an instance ages. Without a cap it silently consumes the budget that target files and interfaces need.

### Precedence

Within context assembly — the only path Memory reaches:

```
1. Live repository state        (ground truth)
2. Pinned input artifacts       (the contract for this unit)
3. Policy-derived facts         (bindings, obligations)
4. Memory                       (advisory, lowest)
```

### Conflict handling

> **Conflicting Memory is dropped and flagged. It is never merged.**

Silent merge produces internally inconsistent context that no one can debug — the model receives two contradictory statements with no signal about which is authoritative, and its output cannot be attributed to either.

Compilation steps (extending Note 01 §14 step 4):

```
· Retrieve candidate records by scope and status
· For each candidate, evaluate `asserted_against`:
      referent unchanged  → include, mark `verified`
      referent changed    → include, mark `unverified`     ★
      referent unresolvable → DROP, record reason
· Detect direct contradiction with a higher-precedence tier:
      → DROP, record reason, emit staleness signal
· Apply max_tokens; drop lowest-priority-within-layer first
· Record ALL of the above in the ContextManifest
```

### `asserted_against` and `unverified` ★

Every record names the repository commit, artifacts, or policy version it was true against. At compile time the Compiler checks whether those referents have changed since.

- **Unchanged** → the record is presented as current.
- **Changed** → the record is included but **marked `unverified` in the rendered context and in the manifest**. The model sees it as a possibly-stale observation rather than as fact.
- **Unresolvable** (the referenced artifact was archived, the commit is gone) → dropped, reason recorded.

Repeated `unverified` marks on a record are the **staleness signal** that triggers human review. This makes staleness detectable at compile time, cheaply, rather than discovered when a decision built on it goes wrong.

Note the interaction with §2: a `heuristic` about a subsystem that has since been rewritten will mark `unverified` on its first compile after the rewrite — which is exactly when it becomes dangerous and exactly when you want to be told.

---

## 9. Scope and isolation

### Scope model

`ScopeSpec` is a selector **within one instance**. The lattice's top element is the instance itself.

```yaml
ScopeSpec:
  level:   org | project | domain | subsystem | path
  selector: string        # instance-local name or path glob
```

| Level | Meaning | Example |
|---|---|---|
| `org` | The whole instance | "Customers are 3PLs" |
| `project` | A named project within the instance | "Onboarding revamp" |
| `domain` | A conceptual area | "billing", "identity" |
| `subsystem` | A named module | "payments" |
| `path` | A path glob in the bound repository | `src/payments/**` |

### Isolation ★

> **`org` is the top of the scope lattice. There is nothing above it.**

This is the design's answer to cross-instance leakage. "Organisation memory" sounds like it should span instances — a shared corporate knowledge base above the company runtimes. It must not, and the mechanism is that the scope vocabulary provides no way to express it.

Following Note 04 §13:

1. **No field in `MemoryRecord` may name another instance.** Not an allowlist, not a share, not a federation setting.
2. **`ScopeSpec.selector` resolves against instance-local names only** — projects, domains, subsystems, and paths in *this* instance's bound repository (Note 04 §7).
3. **Retrieval is instance-scoped below the application layer** (Note 04 §13), not by a query filter that could be omitted.
4. **`evidence[].ref` must resolve to an instance-local artifact or event.** An evidence ref that does not resolve within the instance fails the gate (§11).

Cross-instance knowledge sharing, if it is ever wanted, is a human copying a statement into another instance's proposal queue, where it goes through that instance's own gates and approval. There is no machine path, and there should not be one: the two instances have different repositories, different policies, and different truths.

---

## 10. Memory safety

Architectural controls, not prompt instructions.

| Threat | Control | Mechanism |
|---|---|---|
| **Memory poisoning** — an agent promotes a wrong generalisation into durable belief | No agent write path exists (§4, §12); human approval mandatory; evidence required for agent proposals; mandatory expiry on heuristics | §4, §5, §6 |
| **Stale heuristics** | `asserted_against` → `unverified` marking at compile time; mandatory expiry; repeated `unverified` triggers review | §8 |
| **Incorrect human assumptions** | Partially addressed — see below | §10.1 |
| **Contradictory records** | ★ Overlapping scope + same kind ⇒ the new proposal **must** declare `supersedes`, or it is rejected. Two active records may not contend for the same scope | §11 gate `memory.scope_disjoint` |
| **Malicious or untrusted evidence** | ★ `evidence[].ref` may only be an **instance-local, content-addressed** artifact, event, or gate result. Never free text, never an external URL, never content an agent read | §11 gate `memory.evidence_resolvable` |
| **Duplicating repository truth** | The disposition test (§1) enforced as a gate; statements naming symbols, paths, or signatures are rejected | §11 gate `memory.not_structural` |
| **Agents promoting guesses** | Humans may assert; **agents must evidence**. An agent proposal with no resolvable refs is rejected before human review | §4, §11 |

### 10.1 Incorrect human assumptions — honestly

Humans are wrong too, and a human-asserted `knowledge` record needs no evidence by design (§4). **No mechanism in this design prevents a confidently wrong human belief from entering Memory.**

What is available is **detection, not prevention**:

- The record is labelled `human_assertion`, so its basis is visible in every context it enters rather than blending with evidenced records.
- It is versioned and attributed, so forensic replay (§13) can show exactly which memory shaped a decision that went wrong.
- Review horizons force periodic reconsideration.
- Retraction is cheap and preserves history.

I state this plainly rather than claiming coverage: the authority to assert domain truth is a legitimate human authority, and a system that tried to gate it would be both wrong and unusable. The design's honest position is that human error in Memory is **traceable and correctable**, not preventable.

### 10.2 The compounding property worth naming

Memory poisoning is uniquely dangerous among this architecture's failure modes because **nothing downstream fails**. A bad diff fails a gate. A bad plan fails validation. A bad architecture decision fails its constraint checks. A bad memory record produces slightly worse context on every future unit in its scope, indefinitely, with no failing signal anywhere — and by the time anyone notices, dozens of accepted units have been shaped by it.

That asymmetry is the entire justification for controls that look disproportionate against a single record: mandatory human approval for an advisory input, mandatory expiry on generalisations, and evidence requirements on agent proposals. The controls are sized against the *cumulative* harm, not the individual one.

---

## 11. Memory gates

Reusing Note 03's registry unchanged: same `Gate` schema, same four-valued verdicts, same profiles, same union composition, same `must_fail` fixture requirement. **No new gate machinery.**

`GateProfile: memory_proposal@1.0.0` — six gates, five of them C0:

| Gate | Class | Blocking | `pass_means` |
|---|---|---|---|
| `memory.schema_valid` | C0 | yes | The proposal validates against `schema://memory_proposal/1.0.0` |
| `memory.kind_constraints` | C0 | yes | Kind-specific rules hold: heuristic/objective have `expires_at`; heuristic scope is not `org`; objective statement is not phrased as a requirement |
| `memory.evidence_present` | C0 | yes | An agent-proposed record has ≥1 evidence ref; human assertions are exempt and labelled |
| `memory.evidence_resolvable` | C0 | yes | Every `evidence[].ref` resolves to an instance-local, content-addressed artifact, event, or gate result |
| `memory.scope_disjoint` | C0 | yes | No active record of the same kind contends for an overlapping scope, unless this proposal declares `supersedes` |
| `memory.not_structural` | **C2** | advisory | The statement describes disposition, meaning, or intent — not repository structure (§1) |

### Notes

- **Five of six are C0**, satisfying Note 02 §3 rule 4 (at least one C0/C1 criterion) comfortably. Memory proposals are cheap to check.
- **`memory.not_structural` is C2 and advisory**, and I want the reason on record: the disposition/structure boundary is a judgement, not a predicate. A C0 heuristic ("rejects statements containing a path separator") would produce false rejections on legitimate scoped observations. Advisory means it surfaces a finding the human approver sees, which is the right place for a judgement call that a human is about to make anyway.
- **The human approval gate is `memory.approval`, C3**, bound per §2's approval bar. It is subject to §6's non-blocking rule — the one place memory diverges from Note 02 §12's default handling.
- **Every gate reads the proposal artifact subject to Note 03 §5's visibility ceiling.** No memory gate can read `reasoning_trace` (private) — see §16.

---

## 12. Operations

| Operation | Actor | Authorisation | Produces | Notes |
|---|---|---|---|---|
| `propose` | Agent via WorkUnit, or human | Role admitted (Note 04 §8); any human principal | `MemoryProposal` artifact | The **only** agent-reachable operation |
| `commit` | **Kernel only** | Valid `Approval` bound to the proposal's content hash | `MemoryRecord` | No other actor may create a record |
| `retrieve` | **Context Compiler only** | Recipe declares a `memory` layer | Context layer + manifest entries | §7 |
| `supersede` | Human approval of a new proposal | Approval bar for the kind | New version; old → `superseded` | Both retained |
| `retract` | **Human only** | Instance owner | Status change + `retraction` | **Never deletes** |
| `expire` | **Kernel, automatic** | `expires_at` reached | Status change | No human action; leaves context immediately |

**There is no `delete`, no `edit`, and no `activate`.** Their absence is load-bearing: deletion breaks replay, editing breaks content addressing, and reactivation would allow a retracted belief to return without re-justification.

---

## 13. Replay implications

Memory is a context source, so Note 02 §14's three modes apply.

| Mode | Question | Memory's contribution | Guaranteed? |
|---|---|---|---|
| **1. Audit replay** | What did the system see? | Exact record ids@versions included, with `verified`/`unverified` marks | **Always** |
| **2. Context replay** | Does recompiling reproduce the manifest hash? | Requires the same records at the same versions, and the same `asserted_against` evaluation | **Yes**, given intact history |
| **3. Execution replay** | What would the model do now? | Historical memory set can be reconstructed for A/B | Not deterministic (unchanged) |

### What the `ContextManifest` must record ★

Recording only what was *included* is insufficient. Forensic replay must be able to answer *"which Memory versions were available to the Context Compiler at that time"* — including what was considered and rejected, because a dropped record is often the explanation.

```yaml
manifest.layers.memory:
  selector_evaluated:  ScopeSpec
  candidate_set:                       # everything the selector matched
    - { id, version, content_hash, status_at_compile }
  included:
    - { id, version, mark: verified | unverified }
  dropped:
    - { id, version, reason: contradicted_higher_tier
                           | referent_unresolvable
                           | truncated_by_budget }
  layer_tokens: int
  layer_hash:   Hash
```

Three properties follow:

1. **Historical context reconstruction** works because records are immutable, versioned, and non-deletable. The set active at time *T* is derivable from `effective_from`, `expires_at`, and status transitions in the event log.
2. **Forensic replay** can attribute a bad decision to a specific memory version, and `provenance` then names the proposal, the proposing WorkUnit, and the approving human.
3. **Retraction does not break replay.** A retracted record still existed and was still in context during the period it was active. This is precisely why deletion is prohibited (§12) — deleting a record that turned out to be wrong would destroy the evidence needed to understand what it caused.

---

## 14. Contradictions and amendments

Genuine contradictions only. D1–D5 were raised by Boundary Proposal 04a and are already in the ledger; D6–D7 are new to this note.

### Already in the ledger (04a)

| # | Source | Conflict | Amendment |
|---|---|---|---|
| D1 | Note 01 §6 | Defines four memory types; three are not Memory under Notes 02–04 | Replace with the five kinds in §2 |
| D2 | Note 01 §12, §13 | Recipes imply approved heuristics enter context but define no memory layer | Add the `memory` layer per §8 |
| D3 | Note 03 §2 | `Gate.requires_context` omits memory by accident, not by rule | State the prohibition; enforce at registration (§7) |
| D4 | Note 02 §12, Note 04 §11 | Memory approvals would consume attention budget and throttle real work | Non-blocking, excluded from pause calculation (§6) |
| D5 | Note 02 §14 | Memory immutability implied but unstated | State as derived requirement (§3) |

### New in this note

| # | Source | Conflict | Smallest amendment |
|---|---|---|---|
| **D6** | Note 01 §4, Note 02 §1 | **The durable-object taxonomy has no slot for `MemoryRecord`.** Note 01 §4 divides everything into *configuration* (human-authored, versioned, immutable) and *runtime state* (machine-generated, append-only). Note 02 §1 names three runtime primitives. A `MemoryRecord` is neither: it is human-approved but not config, durable but not runtime, and produced from an artifact but not itself a WorkUnit output. | Name a **third durable category — "approved durable context"** — with the properties in §3: instance-scoped, versioned, immutable, non-deletable, human-approved, read only by the Context Compiler. One paragraph in Note 01 §4. |
| **D7** | Note 04 §4, §18 | **`InstancePolicy` has no memory governance.** Note 04 §18 assigns company knowledge to Memory but the policy schema has no memory block — so an instance cannot disable `heuristic` entirely, set kind-specific approval bars or expiry defaults, delegate memory approval, or set a memory retention horizon distinct from `audit_horizon`. A regulated instance (Note 04 §17, Meridian) plausibly forbids agent-proposed heuristics outright and has no way to say so. | Add a `memory_policy` block to `InstancePolicy` under **Oblige/Narrow only**: `kinds_enabled`, `approval_bar_by_kind`, `max_expiry_by_kind`, `agent_proposals_enabled`, `memory_retention`. Narrowing only — no instance may loosen a kind's approval bar below the Note 05 default. |

**No contradiction found with:** Note 01 §4/§16 (no Role memory — confirmed and reinforced), Note 01 §14 (Context Compiler — memory is an ordinary layer with derived constraints), Note 02 §4/§5 (`MemoryProposal` is an ordinary Artifact with ordinary segment visibility), Note 02 §12 (human-only approvals — preserved), Note 03 §5/§8/§9/§10 (gate registry reused unchanged), Note 04 §13 (isolation — reinforced by §9), Note 04 §18 (governance/knowledge boundary — this note is its implementation).

---

## 15. Open questions

### Decided in this note

| Decision | §|
|---|---|
| `objective` remains a Memory kind; may inform work, may never spawn work; never an `intent_ref` | §2.6 |
| The taxonomy is closed at five kinds | §2 |
| No agent write path to Memory, at any tier, under any policy | §4, §12 |
| Humans may assert without evidence; agents may not | §4 |
| Mandatory expiry on `heuristic` and `objective` | §2, §3 |
| No numeric confidence field | §3 |
| Memory reachable only from the Context Compiler, enforced by disjoint source enumerations | §7 |
| Memory is always the first layer truncated; never priority 1 | §8 |
| Conflicting memory is dropped and flagged, never merged | §8 |
| `org` is the top of the scope lattice; no cross-instance path exists | §9 |
| Overlapping scope of the same kind requires supersession | §10, §11 |
| Evidence refs must be instance-local and content-addressed | §10, §11 |
| Six memory gates, reusing Note 03's registry unchanged | §11 |
| Memory approvals are non-blocking with no SLA | §6 |
| No delete, no edit, no reactivate | §12 |
| The manifest records candidate, included, and dropped sets | §13 |

### Deliberately deferred

| Question | Why deferred |
|---|---|
| **Retrieval mechanism** — how `scope_match` actually selects records | Requires the `SelectorExpr` grammar, open since Note 01 and now serving four consumers. Deciding it here would be deciding it badly |
| **Ranking within the memory layer** — which records survive truncation when the cap binds | Needs real data on memory-set sizes. A wrong ranking rule is worse than an arbitrary one that is later measured |
| **Expiry defaults per kind** | 90 days for heuristics and 12 months for review horizons are placeholders, not findings |
| **Memory volume limits per instance** | Related to ranking; premature without data |
| **Whether `preference` should be principal-scoped rather than instance-scoped** | Interacts with the multi-principal model, which Note 04 only sketched |
| **Staleness-review workflow** | The signal is defined (§8); the human process around it is operations, not architecture |
| **Storage, indexing, embeddings, retrieval algorithms** | Out of scope by instruction, and correctly so — five notes in, the model has not been shaped by a database |

---

## 16. Worked example

**One coherent timeline.** The elapsed gaps are load-bearing, not incidental — each demonstrates a rule from an earlier section.

| Date | Stage | Elapsed | Demonstrates |
|---|---|---|---|
| 2026-08-12 11:02 | Intent raised | — | — |
| 2026-08-12 | Investigation unit runs; `mp_0077` produced and gated | same day | Memory proposals are ordinary WorkUnit output |
| 2026-08-12 → 08-14 | Proposal sits awaiting review | **+2 days** | **§6 non-blocking**: no escalation, no dispatch pause, no SLA. Other work proceeded normally throughout |
| 2026-08-14 09:20 | Approved and committed as `mem_0041` | — | §5, §12: human approves, kernel commits |
| 2026-09-04 | Unrelated refunds unit compiles context | **+3 weeks** | **§8 staleness**: repo moved to `c40b118`, record marks `unverified` |
| 2026-11-10 | `expires_at` | +90 days from authoring | §2: mandatory heuristic expiry |

### Stage 0 — Human observation

```yaml
Intent:
  id: int_0114
  raised_by: human:founder
  statement: "We have discovered that the payment module has weak test isolation."
  raised_at: 2026-08-12T11:02:00Z
```

The founder's observation is an `Intent`, not a memory write. It produces a plan with one node.

### Stage 1 — Investigation WorkUnit

```yaml
WorkUnit:
  id: wu_301
  class: investigation                      # Note 02 §17.1
  objective: "Assess test isolation in the payments subsystem and, if supported by
              evidence, propose a durable heuristic."
  expected_output: MemoryProposal
  acceptance_criteria:
    - { id: m1, class: C0, statement: "Proposal is schema-valid.",
        check: { gate_ref: "gate://memory.schema_valid@1.0.0" } }
    - { id: m2, class: C0, statement: "Evidence refs resolve to instance-local records.",
        check: { gate_ref: "gate://memory.evidence_resolvable@1.0.0" } }
  affected_paths: []                         # investigation writes no code
  budget: { execution: $3.00, verification: $1.00, max_attempts: 2 }
```

Capabilities: read-only repository, read access to instance-local artifacts and gate results. **No write capability, no network egress.**

### Stage 2 — `MemoryProposal` artifact

```yaml
Artifact:
  id: mp_0077
  type: MemoryProposal
  schema_ref: "schema://memory_proposal/1.0.0"
  produced_by: { work_unit_id: wu_301, attempt_id: att_0301_1,
                 role_ref: "investigator@1.0.0" }
  segments:
    - name: proposed_record   visibility: public
      content:
        kind: heuristic
        statement: "The payments subsystem has weak test isolation; unit tests there
                    share mutable fixture state. Prefer integration tests, or assert
                    fixture reset explicitly, for changes under src/payments/**."
        scope: { level: path, selector: "src/payments/**" }
        asserted_against: { repo_commit: "a91f3c2" }
        expires_at: 2026-11-10T00:00:00Z          # 90 days, mandatory for heuristic
        supersedes: null
    - name: evidence          visibility: public
      content:
        - { kind: gate_result, ref: "gr_1188",
            note: "tests.affected_pass indeterminate 3/5 runs, wu_288" }
        - { kind: gate_result, ref: "gr_1204",
            note: "tests.affected_pass indeterminate 2/3 runs, wu_291" }
        - { kind: artifact,    ref: "vr_0402",
            note: "VerificationReport finding f3: shared fixture mutation, payments" }
        - { kind: event,       ref: "ev_55021",
            note: "3 gate `indeterminate` verdicts in payments scope over 14 days" }
    - name: justification     visibility: restricted
      content: "Flake clusters in one subsystem and correlates with fixture reuse
                identified in vr_0402…"
    - name: reasoning_trace   visibility: private
      content_ref: trace_9f02
```

Note that the evidence is entirely **instance-local, content-addressed refs** — gate results and artifacts the system itself produced (Note 03 §7's `indeterminate` verdicts, doing exactly the job §7 promised: making flake visible instead of absorbable). Nothing was read from the web, and nothing is free text presented as fact.

### Stage 3 — Memory gates

Profile `memory_proposal@1.0.0`, ordered by Note 03 §10:

| Gate | Verdict | Evidence |
|---|---|---|
| `memory.schema_valid` | pass | — |
| `memory.kind_constraints` | pass | `expires_at` present; scope is `path`, not `org` |
| `memory.evidence_present` | pass | 4 refs; proposer is an agent, so refs were required |
| `memory.evidence_resolvable` | pass | All 4 resolve within instance `northstar` |
| `memory.scope_disjoint` | pass | No active heuristic contends for `src/payments/**` |
| `memory.not_structural` | pass (advisory) | Statement describes disposition, not structure |

**What the gates could not see** ★

| Segment | Visibility | Reachable by gates? |
|---|---|---|
| `proposed_record` | public | Yes |
| `evidence` | public | Yes |
| `justification` | restricted | Only if a gate declares it in `requires_segments` — none does |
| `reasoning_trace` | **private** | **No. Unaddressable by any gate, by any recipe, ever** |

Per Note 03 §5's visibility ceiling, no gate evidence quotes anything above `public`, so every `GateResult` here is itself `public` and may flow onward. The investigator's reasoning about *why* it believed the generalisation holds never reaches the gates or the approver's decision surface — the approver sees the claim and the evidence, and judges those.

### Stage 4 — Human approval

```yaml
Approval:
  id: appr_0091
  subject: { kind: artifact, ref: mp_0077, content_hash: "sha256:4d1e…" }
  decision: approve
  approver: human:founder
  scope: { reuse: one_time }
```

Non-blocking (§6): this proposal sat for two days while other work proceeded normally. No escalation was raised, no dispatch paused, and it did not count toward the principal attention budget's pause calculation.

### Stage 5 — Commit

```yaml
MemoryRecord:
  id: mem_0041
  instance_id: northstar
  version: 1.0.0
  kind: heuristic
  statement: "The payments subsystem has weak test isolation…"
  scope: { level: path, selector: "src/payments/**" }
  asserted_against: { repo_commit: "a91f3c2" }
  evidence: [ gr_1188, gr_1204, vr_0402, ev_55021 ]
  provenance:
    proposal_id: mp_0077
    proposed_by: "investigator@1.0.0"
    work_unit_id: wu_301
    approved_by: human:founder
    approval_ref: appr_0091
    committed_at: 2026-08-14T09:20:00Z
  status: active
  effective_from: 2026-08-14T09:20:00Z
  expires_at: 2026-11-10T00:00:00Z        # as proposed — NOT rebased to commit date
```

**Why `expires_at` is not rebased at commit.** It sits inside the `proposed_record` segment, so it is part of the content hash the human approved. Note 02 §12 binds an `Approval` to that hash — silently shifting the expiry by two days at commit would void the approval it was granted under. The approver approved a record that expires on 10 November, and that is the record that gets committed. `effective_from` records the commit moment separately.

### Stage 6 — A later, unrelated WorkUnit

Three weeks later, an implementation unit under `src/payments/refunds.ts`, spawned by an unrelated intent about refund handling. Repository is now at commit `c40b118`.

```yaml
manifest.layers.memory:
  selector_evaluated: { level: path, selector: "src/payments/**" }
  candidate_set:
    - { id: mem_0041, version: 1.0.0, status_at_compile: active }
    - { id: mem_0019, version: 2.0.0, status_at_compile: active }   # org knowledge
  included:
    - { id: mem_0041, version: 1.0.0, mark: unverified }   ★
    - { id: mem_0019, version: 2.0.0, mark: verified }
  dropped: []
  layer_tokens: 210
  layer_hash: "sha256:7e30…"
```

`mem_0041` is marked **`unverified`** because `asserted_against.repo_commit` (`a91f3c2`) is no longer HEAD and `src/payments/**` has changed since. The implementer sees it as a possibly-stale observation, not as fact. Repeated `unverified` marks on this record are the staleness signal that will surface it for human review before its expiry.

**What the executor sees** (priority 5, 210 tokens, after everything authoritative):

```
── Memory (advisory; lowest precedence; may be outdated) ──────────
[heuristic · scope src/payments/** · UNVERIFIED: asserted against
 commit a91f3c2, repository has changed since]
  The payments subsystem has weak test isolation; unit tests there share
  mutable fixture state. Prefer integration tests, or assert fixture reset
  explicitly, for changes under src/payments/**.

[knowledge · scope org · verified]
  Customers are 3PLs, not carriers.
───────────────────────────────────────────────────────────────────
```

**What the gates on this unit cannot see** ★

When this implementation unit's diff reaches `tests.affected_pass`, `api.schema_unchanged`, and `review.independent`, **none of them can read `mem_0041`, or any memory at all.** `Gate.requires_context` (Note 03 §2) enumerates `workspace_snapshot | baseline_artifact | constraint_refs | runtime_environment` — a set disjoint from the memory source by construction (§7, amendment D3).

So the heuristic influenced *how the implementer approached the change*, and had **zero** influence on whether the change was accepted. The verifier judged the diff against the spec and the constraints, exactly as it would have with an empty memory store.

**That is the invariant, demonstrated end to end: Memory informed. It did not constrain.**

---

## 17. Architectural invariants

Statements implementation must never violate.

1. **Memory informs; it never constrains.** Memory may influence context assembly and nothing else.
2. **The Context Compiler is the sole consumer of Memory.** Gates, the capability broker, kernel validation, policy composition, budget enforcement, and spec resolution have no path to it — enforced by disjoint source enumerations, not by rule.
3. **No agent may write durable Memory.** Agents emit `MemoryProposal` artifacts. There is no privileged mutation channel at any tier, under any policy.
4. **Every `MemoryRecord` traces to a human `Approval`** bound to its proposal's content hash. Only a human principal may approve; only the kernel may commit.
5. **`MemoryRecord`s are immutable, versioned, and content-addressable.** Corrections supersede; they never edit.
6. **`MemoryRecord`s are never deleted.** `expired` and `retracted` are statuses. Deletion would break replay of every execution that saw the record.
7. **Memory is instance-scoped, and `org` is the top of the scope lattice.** No field may name another instance; there is no machine path between instances.
8. **`evidence[].ref` must be instance-local and content-addressed.** Never free text, never an external URL, never content an agent read.
9. **Agents must evidence; humans may assert.** An agent proposal without a resolvable ref is rejected before human review.
10. **`heuristic` and `objective` records carry a mandatory `expires_at`.** Expiry is automatic and requires no human action.
11. **Memory is never context priority 1.** It is always the first layer truncated when a budget binds.
12. **Conflicting Memory is dropped and flagged, never merged.** Precedence is repository, then pinned artifacts, then policy-derived facts, then Memory.
13. **Two active records of the same kind may not contend for overlapping scope.** A contending proposal must declare `supersedes`.
14. **Memory approvals are non-blocking.** They raise no escalation, pause no dispatch, and have no SLA.
15. **An `objective` may inform work but never spawn it.** An objective appearing as a `WorkUnit.intent_ref` is a validation failure.
16. **Memory carries no numeric confidence.** Justification is `evidence[]` or an explicit `human_assertion` label.
17. **The `ContextManifest` records the candidate, included, and dropped memory sets with reasons** — so a historical execution can always determine which Memory versions were available to the Context Compiler.

---

*End of Design Note 05.*

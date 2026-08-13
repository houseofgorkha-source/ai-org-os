# AI-Org OS — Design Note 06
## Execution Semantics

**Status:** Draft for review
**Scope:** Runtime state, concurrency, idempotency, failure recovery, and the event contract. **No storage engine, no queue technology, no lock implementation, no scheduling algorithm.**
**Depends on:** Notes 01–05, Note 07, and accepted amendments A1–A11, B1–B10, C1–C5, D1–D7
**Position:** Second of the three closing architecture notes (07 → **06** → 08).

Notes 02–04 specify what is validated and what composes. Note 07 specifies what an Executor is. This note specifies what happens when things run at the same time, and when they die.

---

## Table of contents

1. [What the kernel owns](#1-what-the-kernel-owns)
2. [State machines](#2-state-machines)
3. [Leases and the single-executor guarantee](#3-leases-and-the-single-executor-guarantee)
4. [The workspace as fence](#4-the-workspace-as-fence)
5. [Idempotency](#5-idempotency)
6. [Budget: the spend-point rule](#6-budget-the-spend-point-rule)
7. [Budget reservation under concurrency](#7-budget-reservation-under-concurrency)
8. [The critical section: harvest → gate → accept](#8-the-critical-section-harvest--gate--accept)
9. [Crash recovery](#9-crash-recovery)
10. [Concurrency invariants and admission control](#10-concurrency-invariants-and-admission-control)
11. [The event contract](#11-the-event-contract)
12. [Ordering and causality](#12-ordering-and-causality)
13. [Clock authority](#13-clock-authority)
14. [In-flight work and configuration change](#14-in-flight-work-and-configuration-change)
15. [Worked example: crash recovery](#15-worked-example-crash-recovery)
16. [Challenges](#16-challenges)
17. [Invariants](#17-invariants)
18. [Deferred](#18-deferred)

---

## 1. What the kernel owns

Restated tightly, because this note is where the boundary becomes operational.

| Kernel owns | Kernel does **not** own |
|---|---|
| Dispatch and scheduling | What the model does (Executor, Note 07) |
| All state transitions | Verdicts (Gates, Note 03) |
| Leases and ownership | Approvals (humans, Note 02 §12) |
| Budget reservation and enforcement | Cost measurement (Model Broker, Note 07 §8) |
| Harvest and artifact construction | Artifact content (derived from workspace) |
| Clock authority for every decision | — |
| The event stream | — |

**The kernel contains no model call.** This was asserted in the first conversation and holds through six notes: an LLM in the control plane means orchestration state can be hallucinated, and every failure becomes unfalsifiable. Everything in this note is deterministic code.

---

## 2. State machines

### 2.1 `WorkUnit`

| From | To | Actor | Trigger |
|---|---|---|---|
| `draft` | `validated` | kernel | All Note 02 §9 checks pass |
| `draft` | `invalid` | kernel | Any check fails — **never runs** |
| `validated` | `ready` | kernel | Dependencies terminal; blocking pre-dispatch approvals present |
| `validated` | `blocked` | kernel | An upstream dependency failed |
| `ready` | `running` | kernel | Lease acquired **and** budget reserved **and** workspace provisioned |
| `running` | `verifying` | kernel | Executor terminated `completed`; harvest complete |
| `running` | `attempt_failed` | kernel | Executor terminated with a fault (Note 07 §13) |
| `verifying` | `awaiting_approval` | kernel | All blocking gates `pass`; a C3 gate is pending |
| `verifying` | `attempt_failed` | kernel | A blocking gate returned `fail` |
| `verifying` | `escalated` | kernel | A blocking gate returned `indeterminate` |
| `awaiting_approval` | `accepted` | kernel | Approval recorded against the artifact's content hash |
| `awaiting_approval` | `rejected` | human | — |
| `attempt_failed` | `ready` | kernel | Attempts remain **and** `on_failure` says retry |
| `attempt_failed` | `exhausted` | kernel | Attempts spent |
| `attempt_failed` | `escalated` | kernel | `on_failure` says escalate, or `no_progress` detected |
| `exhausted` | `escalated` | kernel | Always |
| *any non-terminal* | `cancelled` | human, or kernel on parent-plan failure | — |

**Terminal:** `accepted`, `rejected`, `invalid`, `cancelled`, `escalated` (until a human resolves it).

`blocked` remains distinct from `attempt_failed` (Note 02 §2): a unit whose dependency failed did nothing wrong, and conflating them corrupts every quality metric computed later.

### 2.2 `Attempt`

| From | To | Actor | Trigger |
|---|---|---|---|
| — | `running` | kernel | Dispatch; ordinal assigned |
| `running` | `completed` | kernel | Executor returned `completed` |
| `running` | `failed` | kernel | Executor fault |
| `running` | `timed_out` | kernel | Deadline exceeded |
| `running` | `denied` | kernel | Denial budget spent (Note 07 §7) |
| `running` | `budget_exhausted` | kernel | Any budget axis hit |
| `running` | `cancelled` | kernel | Unit cancelled |
| `running` | `superseded` | kernel | **Lease lost** — see §3 |

Attempts are **append-only and immutable once terminal.** A retry never mutates a prior attempt.

### 2.3 `Artifact`

Per Note 02 §4: `draft → verified → accepted`, or `rejected`, or `abandoned`. `superseded` is set later by a successor.

Only the kernel writes artifact status. `abandoned` (cancel/timeout/exhaustion) is never `draft`, because `draft` invites consumption and `abandoned` is terminal and unconsumable.

### 2.4 `Plan`

| From | To | Actor | Trigger |
|---|---|---|---|
| `draft` | `approved` | human | Plan-level approval (Note 02 §12) |
| `approved` | `running` | kernel | First node dispatched |
| `running` | `complete` | kernel | All nodes `accepted` |
| `running` | `partial` | kernel | All nodes terminal; ≥1 not `accepted` |
| `running` | `cancelled` | human | — |

**A node's failure does not fail the plan** (Note 02 §8 rule 5). Independent branches continue; the plan reaches `partial` and escalates with an explicit accounting.

---

## 3. Leases and the single-executor guarantee

Nothing so far prevents two schedulers dispatching the same `ready` unit.

```yaml
Lease:
  work_unit_id, attempt_id
  epoch:        int                # monotonic per work unit  ★
  holder:       SchedulerId
  acquired_at, expires_at
  renewed_at
```

**Rules**

1. **A unit transitions to `running` only on lease acquisition.** Acquisition is a compare-and-set on `(work_unit_id, epoch)`; the loser does not dispatch.
2. **Leases are renewed while the attempt runs**, at an interval well under expiry.
3. **Lease expiry does not kill anything.** It makes the lease *available*, and a new attempt may be dispatched at `epoch + 1`.
4. **The prior attempt becomes `superseded`**, not `failed`. It may still be executing; the kernel does not assume it stopped.
5. **`superseded` consumes no attempt from the unit's budget.** Losing a lease is an infrastructure event, exactly as Note 03 §4's `error` is — the unit did nothing wrong.

### Split-brain is expected, not prevented ★

A lease can expire while its executor is alive and healthy — a slow model call, a paused container, a network partition between scheduler and executor. **Attempting to prevent this requires distributed consensus the design does not need.** Instead the design makes a superseded executor *harmless*, which §4 covers.

---

## 4. The workspace as fence ★

The fencing mechanism is already present in the architecture and needs only to be named.

> **Harvest is kernel-side (Note 07 §3), and the kernel harvests a workspace only if that workspace's attempt still holds the current lease epoch.**

```
Executor A (epoch 4) — still running, lease expired
Executor B (epoch 5) — dispatched into a FRESH workspace

Executor A terminates
   → kernel checks: attempt epoch 4 < current epoch 5
   → attempt marked `superseded`
   → workspace DISPOSED WITHOUT HARVEST
   → no artifact, no gate run, no state change
```

A superseded executor cannot produce an artifact **because it was never able to produce one** — Note 07 §3 already removed that capability, and the fence is simply the epoch check at harvest. Two executors running concurrently is wasteful, not incorrect.

**This makes Note 07 §3 and this section load-bearing for each other.** If anything ever permits an executor to submit its own artifact, the fence is gone and split-brain becomes a correctness problem rather than a cost problem. That coupling should be recorded wherever either is changed.

---

## 5. Idempotency

Every operation the kernel may retry after a fault is idempotent under a stated key.

| Operation | Idempotency key | Repeat behaviour |
|---|---|---|
| Attempt creation | `(work_unit_id, ordinal)` | No-op; returns the existing attempt |
| Workspace provisioning | `(attempt_id)` | Returns the existing workspace |
| Tool invocation | `(attempt_id, seq)` | Broker returns the recorded result |
| Model invocation | `(attempt_id, seq)` | Broker returns the recorded result — **but see §6** |
| Gate execution | `(gate_ref@version, artifact_hash, parameters)` | Note 03 §10's cache key. C0 returns cached |
| Artifact construction | `(work_unit_id, attempt_id, content_hash)` | Deduplicates; no second artifact |
| Approval consumption | `(approval_id, subject_hash)` | No-op |
| Memory commit | `(proposal_id, approval_id)` | No-op (Note 05 §12) |
| Budget decrement | `(attempt_id, seq)` | **Not repeated** — §6 |

**Harvest is idempotent by construction**, because it is a deterministic function of `(workspace, baseline)`. Re-running it produces a byte-identical artifact and therefore an identical content hash, which the construction key then deduplicates. This is the single most useful property in the whole recovery story (§9) and it is a free consequence of Note 07 §3.

---

## 6. Budget: the spend-point rule ★

> **Budget is decremented at the moment of spend, durably, before the result returns to the caller. Never at attempt success.**

The alternative is catastrophic: if budget were decremented on success, a crash-retry loop would spend without bound while recording nothing, and `fail_closed` (Note 02 §8) would be decorative. The Model Broker meters at the call boundary (Note 07 §8), so the durable record of spend exists independently of whether the attempt that caused it ever completes.

**Consequences, stated plainly because two of them feel wrong at first:**

1. **A crashed attempt's cost is real and counted.** The tokens were bought. Recording otherwise would be a lie in the ledger and would make cost-per-accepted-change (Note 03 §17.1) meaningless.
2. **A superseded attempt's cost is also real and counted.** Losing a lease refunds nothing.
3. **Model invocation is idempotent in *effect* but not in *cost*.** Replaying a recorded call returns the recorded result without re-spending; a call that was made but never recorded before a crash is charged and lost. The second case is why the broker records *before* returning, not after.

---

## 7. Budget reservation under concurrency ★

Note 04 §10 gives per-unit and per-instance caps but no reservation model, which leaves a real hole: **ten concurrent units, each within its own ceiling, can jointly breach the instance ceiling.**

```
DISPATCH    reserve = effective_budget.ceiling            (pessimistic)
            admit only if  instance_remaining ≥ reserve
            instance_reserved += reserve

RUNNING     actual spend accumulates at the broker (§6)

TERMINAL    instance_reserved -= reserve
            instance_spent    += actual
            (releases the unspent remainder)
```

**Reservation is pessimistic — the full ceiling, not an estimate.** A unit that reserves $8 and spends $2 has blocked $6 of headroom for its duration. That under-utilises, and it is the correct direction: `fail_closed` means the system must never discover it has overspent, and an optimistic reservation guarantees it eventually will.

Reconciliation must be prompt, since reservation is released only at terminal state — which makes stuck units expensive in headroom as well as in attention. A lease-expiry sweep (§3) that terminalises abandoned attempts is therefore also the budget-recovery path.

---

## 8. The critical section: harvest → gate → accept ★

Between executor exit and unit acceptance lies the only stretch where a crash could leave partial state.

```
FREEZE     workspace read-only            idempotent (already frozen)
HARVEST    diff, scope-check, construct   deterministic → identical hash (§5)
VALIDATE   artifact schema                pure function of content
GATES      ordered, per Note 03 §10       keyed; C0 cached, C1/C2 re-runnable
RECORD     gate results                   keyed by (gate, artifact_hash, params)
ACCEPT     status → accepted              ★ THE IRREVERSIBLE TRANSITION
```

**The governing principle:**

> **Every step is independently idempotent and derivable from durable facts.
> Recovery recomputes from the last durable fact; it never resumes a transaction.**

This is why the design needs no distributed transaction, no two-phase commit, and no saga. Each step is a pure function of state that is already durable, so "where was I?" is answerable by looking at what exists rather than by a journal of intent.

### `accepted` is the one irreversible transition

Everything before it is discardable: abandon the workspace, discard the artifact, re-run the gates. After it, **downstream units may consume the artifact** (Note 02 §10 — only `accepted` artifacts satisfy an artifact edge), and consumption cannot be recalled.

Therefore `accept` is guarded by, and atomic with respect to, three durable facts: all blocking gates recorded `pass`, every required approval exists bound to this content hash, and the artifact validates against its schema. If any is missing on recovery, the unit is not accepted — it recomputes.

---

## 9. Crash recovery

| Crash point | On restart | Cost of recovery |
|---|---|---|
| Before dispatch | Unit still `ready`; dispatch normally | None |
| After lease, before executor start | Lease expires; new attempt at `epoch+1`; old `superseded` | One workspace |
| **During execution** | Lease expires; new attempt in a **fresh** workspace; stale executor fenced at harvest (§4) | Full attempt, incl. model spend (§6) |
| **After executor exit, before harvest** | Workspace preserved and frozen; **harvest re-runs deterministically** | Near zero ★ |
| During gates | Recorded results survive; unrecorded gates re-run; C0 cache hits | Uncached gates only |
| After gates, before accept | Gate results durable; acceptance recomputed from them | None |
| After accept | Terminal; idempotent | None |

**The most expensive crash is mid-execution**, because model spend is real (§6) and the fresh attempt starts over. The *least* expensive is post-exit pre-harvest — the case that would be hardest in a design where the executor submitted its own artifact, and which is nearly free here because harvest is a deterministic function of a preserved workspace.

**Nothing is resumed mid-attempt.** An attempt is atomic from the kernel's view: it either produced a harvestable workspace or it did not. Partial resumption would require the executor to carry durable state across a restart, which Note 07 §9 rule 5 forbids for good reason.

---

## 10. Concurrency invariants and admission control

All enforced at **admission**, before dispatch. None by locking afterwards.

| Invariant | Source | Check |
|---|---|---|
| One executor per attempt | §3 | Lease compare-and-set |
| No two running units with overlapping `affected_paths` | Note 02 §8 | Derived conflict edges evaluated at admission |
| `max_concurrent` per Role | Note 04 §8 | Count running attempts for that Role |
| `max_running_units` per instance | Note 04 §10 | Count |
| `max_model_gate_units` | Note 04 §10 | Count of running C2 gate executions |
| Instance budget headroom | §7 | Reservation |
| Attention budget not breached | Note 04 §11, C1 | Open escalations + pending approvals |

**Admission control rather than locking** is deliberate. A unit that cannot be admitted stays `ready` and is retried by the scheduler; a unit that was admitted runs to completion without contending for anything. This keeps the failure mode "work waits" rather than "work deadlocks," and it means every concurrency rule is a countable predicate over durable state instead of a lock ordering problem.

**Attention-budget breach pauses dispatch** (Note 04 §11): the system stops admitting rather than continuing to generate decisions no human can absorb.

---

## 11. The event contract

> **Every state transition emits an event. All queryable state is a projection over the event stream. No state exists that is not derivable from events.**

### Why event-sourced, and why this is not fashion ★

Note 02 §14 promises that **audit replay always works** — mode 1 is unconditional. If state were mutable and the audit log separate, the two would drift, and every drift silently falsifies that promise for the period it covers. Event sourcing is not chosen here for elegance; it is the only structure under which a guarantee the architecture already made remains true. If that guarantee were dropped, this section should be dropped with it.

### Required event families

| Family | Examples |
|---|---|
| Unit lifecycle | validated, ready, running, verifying, accepted, rejected, escalated, cancelled |
| Attempt lifecycle | started, completed, failed, timed_out, denied, superseded, budget_exhausted |
| Lease | acquired, renewed, expired, superseded |
| Tool | invoked, granted, **denied** (Note 07 §14) |
| Model | invoked, served (with `model_served`), budget_halt |
| Gate | started, result recorded (pass/fail/indeterminate/**error**) |
| Artifact | constructed, validated, verified, accepted, rejected, abandoned, superseded |
| Approval | requested, granted, rejected, expired |
| Escalation | raised, resolved |
| Budget | reserved, spent, released, exhausted |
| Memory | proposed, committed, superseded, expired, retracted (Note 05 §12) |
| Config | spec resolved, policy published, gate registered |

### Envelope

```yaml
Event:
  event_id, instance_id
  type
  occurred_at:     timestamp        # KERNEL clock (§13)
  actor:           kernel | human:<id> | role_ref | broker | gate_ref
  subject:         [Ref]
  causation_id:    EventId?         # the event that caused this one   ★
  correlation_id:  IntentId | PlanId # the originating request         ★
  payload:         {…}
```

**`causation_id` and `correlation_id` are what make forensic replay navigable.** Correlation answers "everything that came from this intent"; causation answers "why did this specific thing happen." Without causation, a failure investigation is a timestamp-ordered scroll; with it, it is a chain.

---

## 12. Ordering and causality

| Guarantee | Required? | Rationale |
|---|---|---|
| **Per-`WorkUnit` total order** | **Yes** | A unit's transitions must be linearizable, or state is ambiguous |
| **Per-`Attempt` total order** | **Yes** | `seq` on tool and model calls (Note 07 §14) |
| **Causal order across units** | **Yes**, via `causation_id` | Explicit, not inferred from clocks |
| **Global total order** | **No** ★ | Nothing needs it, and requiring it is a scalability trap |

**Nothing in Notes 01–07 requires a globally ordered stream.** Replay is per-unit and per-attempt; provenance is by reference and content hash, not by position; plan-level ordering derives from node events plus explicit plan events. Adding a global sequencer would buy a property no consumer uses and make the log a bottleneck for every write in every instance.

**The cost, stated honestly:** "what was the state of the whole instance at time T" becomes a more expensive query than it looks, since it must be assembled per unit rather than read at an offset. That query is rare and is not on any hot path.

---

## 13. Clock authority ★

> **Only the kernel reads wall-clock time for decisions.**

| Component | Reads clock for decisions? |
|---|---|
| Kernel | **Yes — sole authority** |
| Executor | No. Deadline enforced externally (Note 07 §10) |
| C0 gate | **Forbidden** (Note 03 §6 rule 3) |
| C1/C2 gate | May measure elapsed time as *evidence*; never as a *decision* |
| Tool/Model Broker | Token expiry checked against a kernel-supplied instant |

Every time-dependent rule in the corpus is kernel-evaluated: attempt deadlines, capability token expiry (Note 07 §5), approval expiry (Note 02 §12), memory `expires_at` and review horizons (Note 05 §3), lease expiry (§3), rate-limit windows.

This makes clock skew inside sandboxes irrelevant to correctness, keeps event timestamps coherent within an instance, and preserves Note 03 §6's determinism requirement — a C0 gate that could read the clock would not be replayable, and the cache in Note 03 §10 would be unsound.

---

## 14. In-flight work and configuration change

Note 04 §12 established that a `ResolvedExecutionSpec` is flattened and frozen at dispatch, so a config rollout does not disturb in-flight work. Two consequences deserve stating, because both are non-obvious:

1. **A retry reuses the same spec hash** (Note 02 §7 rule 5). A unit that fails, sits through a policy rollout, and retries **runs under the old configuration**. This is correct — the retry is continuing the same contract, and switching configuration mid-contract would mean the attempts are not comparable and the failure evidence from attempt 1 may not apply to attempt 2.
2. **Only a replan picks up new configuration.** New config takes effect at the next *plan*, not the next *attempt*. If a config change must reach in-flight work, the correct action is to cancel and replan — a visible, approved decision — rather than to let the change leak in silently.

The single exception is a human-approved budget increase, which amends the spec, produces a new hash, and records an `Approval` (Note 02 §7 rule 5). Budget increases are never silent.

---

## 15. Worked example: crash recovery

`wu_102` attempt 1 (password-reset rate limiting, Notes 03 §18 / 07 §15). The kernel dies **after the executor exits and before harvest** — the interesting case.

**Before the crash, durable:**

```
ev_9001  attempt.started         att_0102_1, epoch 3, spec sha256:c93d…
ev_9002  lease.acquired          epoch 3
ev_9014  model.served            claude-…, 41,200 in / 3,180 out, $1.42   ← spend recorded
ev_9027  tool.denied             net.fetch, ordinal 1
ev_9051  model.served            …, $1.68                                 ← spend recorded
ev_9063  attempt.completed       termination: completed
                                 ↑ workspace ws_88f1 frozen
*** KERNEL DIES ***
```

**On restart:**

| Step | Kernel action | Outcome |
|---|---|---|
| 1 | Scan for attempts `completed` with no harvest event | `att_0102_1` found |
| 2 | Check lease epoch | Still 3; not superseded. Proceed |
| 3 | Workspace `ws_88f1` still present, frozen | Preserved per Note 07 §9 rule 3 |
| 4 | **Harvest** — diff `ws_88f1` against `a91f3c2` | Deterministic → 3 files, +91/−4, `content_hash: sha256:c1a8…` |
| 5 | Construct artifact, key `(wu_102, att_0102_1, sha256:c1a8…)` | `diff_0212` created |
| 6 | Run gates | Stage 1 C0 all cache-miss (first run) → pass; stage 3 `differential.response_equivalence` → **fail** |
| 7 | Record `FailureRecord`, classify `verification_failed` | Attempt 1 terminal |
| 8 | Release reservation, reconcile spend | reserved $6.00 released; actual **$3.10 retained** (§6) |

**What the crash cost:** nothing but the restart. Harvest recomputed byte-identically (§5), so the artifact is the same artifact it would have been. No duplicate model spend, because no model call was replayed. No lost accounting, because spend was recorded at the broker before the crash (§6).

**Had the crash occurred 30 seconds earlier — mid-execution — the cost would have been the full attempt**: lease expires, attempt 1 marked `superseded` at the sweep, a fresh workspace is provisioned at epoch 4, and the $3.10 already spent stays on the ledger. That asymmetry is the honest shape of the recovery story: **post-exit crashes are nearly free; mid-execution crashes cost a whole attempt.**

**And if executor A had still been alive** when epoch 4 was dispatched, A's eventual exit would find epoch 3 < 4, be marked `superseded`, and its workspace disposed without harvest (§4). Two executors ran; one artifact was possible.

---

## 16. Challenges

### 16.1 Event sourcing is a real and permanent cost

Every projection is code you must write, test, and keep correct as the event vocabulary grows. Rebuilding projections gets slower as history grows. This is genuine overhead and I do not want it waved through as architectural good taste.

It is justified by one thing: Note 02 §14 promises unconditional audit replay. **If that promise is ever relaxed, revisit this section first** — mutable state with a separate audit log is materially cheaper and is the right answer for a system that does not make that promise.

### 16.2 Pessimistic reservation under-utilises

A unit reserving $8 and spending $2 blocks $6 of instance headroom for its duration (§7). Under a low `per_day_cap`, a few concurrent units can make the instance refuse work it could actually afford.

I accept it. `fail_closed` means the failure mode must be "refused work," never "discovered overspend," and optimistic reservation guarantees the latter eventually. Mitigation is prompt reconciliation and a lease sweep that terminalises stuck attempts quickly — which is also the budget-recovery path.

### 16.3 The fence depends entirely on kernel-side harvest

§4's split-brain safety rests wholly on Note 07 §3. Any future change permitting an executor to submit its own artifact converts split-brain from a cost problem into a **correctness** problem, silently. The two sections are load-bearing for each other and neither should be modified without the other in view.

### 16.4 No global order makes some questions expensive

§12's per-unit ordering is right, but "what was the whole instance doing at time T" must be assembled rather than read. Rare, off the hot path, and the alternative is a global sequencer bottlenecking every write — but it will be annoying the first time someone wants an instance-wide timeline.

### 16.5 Recovery correctness is only as good as its scan

§9 depends on the kernel finding orphaned work on restart: attempts `completed` with no harvest, leases expired with attempts `running`, reservations held by terminal attempts. Each is a scan, and **a missing scan produces work that is stuck rather than failed** — invisible, because nothing errors. Every state that can be orphaned needs a corresponding sweep, and that correspondence should be a checklist, not folklore.

### 16.6 Lease duration is an unforced trade-off

Short leases detect death fast and supersede healthy-but-slow executors, wasting whole attempts. Long leases waste headroom and delay recovery. The corpus contains no basis for choosing, because it depends on real attempt durations. Start long (well above p99 attempt duration), measure, tighten.

---

## 17. Invariants

1. **The kernel contains no model call.** All of execution semantics is deterministic code.
2. **Every state transition is emitted as an event; all queryable state is a projection.** No state exists that is not derivable from the stream.
3. **A unit becomes `running` only on lease acquisition, budget reservation, and workspace provisioning — all three.**
4. **Exactly one executor may produce an artifact per unit-epoch**, enforced by the epoch check at harvest, not by preventing concurrent execution.
5. **A superseded attempt's workspace is disposed without harvest.**
6. **`superseded` consumes no attempt from the unit's budget.** Losing a lease is an infrastructure event.
7. **Budget is decremented at the moment of spend, durably, before the result returns.** Never at success.
8. **A crashed or superseded attempt's cost is real and counted.**
9. **Reservation is pessimistic**: the full ceiling is held from dispatch to terminal state.
10. **Every retryable operation is idempotent under a stated key.**
11. **Harvest is a deterministic function of `(workspace, baseline)`** and therefore idempotent.
12. **Recovery recomputes from durable facts; it never resumes a transaction.**
13. **`accepted` is the only irreversible transition** in the unit lifecycle, and is guarded by gate results, approvals, and schema validity together.
14. **Nothing is resumed mid-attempt.** An attempt either produced a harvestable workspace or it did not.
15. **All concurrency rules are enforced at admission, never by locking after dispatch.**
16. **Only the kernel reads wall-clock time for decisions.**
17. **Per-unit and per-attempt total order is required; global total order is not.**
18. **A retry runs under the same `ResolvedExecutionSpec` hash**; only a replan picks up new configuration.

---

## 18. Deferred

| Item | Why |
|---|---|
| Storage engine, event store, projection mechanics | Implementation. The contract is §11 |
| Queue or scheduler technology | Implementation |
| Lease implementation (compare-and-set primitive) | Implementation |
| Concrete lease durations, renewal intervals, sweep frequency | §16.6 — requires measured attempt durations |
| Retry backoff curves | Implementation; `on_failure` policy already states *whether* to retry |
| Scheduling priority among admissible units | Deliberately open. Note 02 §15 rejected free-form priority; a policy-derived ordering belongs with instance policy |
| Projection rebuild and snapshotting strategy | Implementation, and §16.1's cost lives here |
| Multi-scheduler coordination beyond leases | Not needed. Leases plus admission control suffice for a single-instance MVP |

---

*End of Design Note 06.*

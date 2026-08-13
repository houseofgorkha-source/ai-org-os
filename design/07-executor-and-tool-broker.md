# AI-Org OS — Design Note 07
## The Executor and the Tool Broker

**Status:** Draft for review
**Scope:** The contract between the kernel and the component that runs a model with tools. No container technology, no provider adapters, no tool implementations.
**Depends on:** Notes 01–05 and accepted amendments A1–A11, B1–B10, C1–C5, D1–D7
**Position:** First of the three closing architecture notes (07 → 06 → 08).

Note 01 §6 rule 4 states that capability enforcement "lives at the tool broker, in code." The tool broker is referenced seven times across the corpus and specified nowhere. **The architecture's central security claim currently rests on an undefined component.** This note defines it.

---

## Table of contents

1. [What an Executor is](#1-what-an-executor-is)
2. [The Executor contract](#2-the-executor-contract)
3. [Kernel-side harvest](#3-kernel-side-harvest)
4. [The Tool Broker](#4-the-tool-broker)
5. [Capability tokens](#5-capability-tokens)
6. [The tool invocation contract](#6-the-tool-invocation-contract)
7. [The denial path](#7-the-denial-path)
8. [The Model Broker](#8-the-model-broker)
9. [Workspace lifecycle](#9-workspace-lifecycle)
10. [The Sandbox contract](#10-the-sandbox-contract)
11. [Untrusted content posture](#11-untrusted-content-posture)
12. [What an Executor may never do](#12-what-an-executor-may-never-do)
13. [Failure classification at the executor boundary](#13-failure-classification-at-the-executor-boundary)
14. [Observability obligations](#14-observability-obligations)
15. [Worked example](#15-worked-example)
16. [Challenges](#16-challenges)
17. [Invariants](#17-invariants)
18. [Deferred](#18-deferred)

---

## 1. What an Executor is

> **An Executor is a stateless, sandboxed, credential-free process that runs one `Attempt` of one `WorkUnit` and produces a workspace mutation. It does not decide what its output is, whether it succeeded, or what it is permitted to do.**

Three components sit between the kernel and the model, and keeping them separate is the whole design:

```
   KERNEL                         (owns: dispatch, state, budget, harvest, verdicts)
      │  ResolvedExecutionSpec + assembled context + capability token
      ▼
   EXECUTOR                       (owns: the agent loop. Holds NO credentials)
      │                    │
      │ tool calls         │ model calls
      ▼                    ▼
   TOOL BROKER        MODEL BROKER    (own: enforcement, metering, credentials)
      │                    │
      ▼                    ▼
   sandboxed tools    model provider
```

The Executor is the only component in this architecture that runs an untrusted, model-driven loop. Every other component is deterministic code. Consequently **it is the component with the fewest privileges**, not the most — which inverts the intuition that the thing doing the work needs the access.

---

## 2. The Executor contract

```yaml
ExecutorInvocation:                    # kernel → executor
  attempt_id:            AttemptId
  work_unit_id:          WorkUnitId
  execution_spec:        ResolvedExecutionSpec    # flattened, hashed (Note 02 §7)
  assembled_context:     RenderedContext          # from the Context Compiler
  context_manifest_ref:  ManifestId
  capability_token:      CapabilityToken          # §5 — scoped, expiring
  workspace_ref:         WorkspaceRef             # provisioned by the kernel
  deadline:              timestamp

ExecutorResult:                        # executor → kernel
  attempt_id:            AttemptId
  termination:           completed | model_refused | deadline | denial_budget
                         | tool_fault | internal_error
  tool_invocations:      [ToolCallRecord]
  model_invocations:     [ModelCallRecord]
  narrative:             string?                  # PRIVATE. Debugging only.
```

### What is absent, and why

`ExecutorResult` contains **no artifact, no verdict, no status, no consumption figures, and no success claim.**

| Absent field | Owner | Why not the executor |
|---|---|---|
| The produced artifact | Kernel, via harvest (§3) | An executor that reports its own output can omit part of it |
| Success / failure verdict | Gates (Note 03) | Note 01 `self_report_accepted: false` |
| `Attempt.status` | Kernel | Status is a kernel projection over facts, not a self-description |
| Token and cost consumption | Model Broker (§8) | A metered party may not report its own meter |
| Remaining budget | Kernel | — |

`narrative` exists solely so a human debugging a stuck attempt has something to read. It is written to `Attempt.raw_trace_ref` at `private` visibility (Note 02 §6) and is unreachable by any gate, any recipe, and any retry (Note 02 §11).

---

## 3. Kernel-side harvest ★

> **The artifact is *derived from the workspace* by the kernel. It is never *reported by* the executor.**

After the executor terminates, the kernel — not the executor — computes the change:

```
1. FREEZE      Workspace becomes read-only the instant the executor exits
2. DIFF        Compute workspace state against the pinned baseline commit
3. SCOPE       Compare changed paths against WorkUnit.affected_paths
4. CONSTRUCT   Build the CodeDiff artifact, hash it, record provenance
5. VALIDATE    Artifact schema validation (Note 02 §4 invariant 5)
```

### Why this is structural, not procedural

Note 01 established that an agent may not report its own *verdict*. Harvest extends the same principle to its *output*: an executor that constructs its own artifact can omit a file, understate a change, or describe a diff that differs from the workspace it left behind. Deriving the artifact from observable state removes the option.

This is the same move as Note 02 §5 (segment visibility as a capability rather than a filter) and Note 05 §7 (memory unreachability by disjoint enumeration): **the guarantee holds because the channel does not exist.**

### Out-of-scope paths are surfaced, never filtered ★

Step 3 is where a real temptation lives: silently drop changes outside `affected_paths` so the diff stays clean.

**Do not.** Silent filtering hides a scope violation, and a scope violation is one of the highest-signal indicators that a unit misunderstood its objective (Note 02 §8). Out-of-scope changes are **included in the artifact and flagged**, so the `locality` constraint gate (Note 03 §12) fails loudly and the failure evidence names the offending paths.

A dirty workspace is a fact about the attempt. Cleaning it before measurement destroys the measurement.

---

## 4. The Tool Broker

> **The Tool Broker is the sole path from an Executor to any effect outside its own process. It is deterministic code. It holds the credentials the Executor does not.**

Responsibilities:

| Responsibility | Note |
|---|---|
| Verify the capability token on every call | Not once at start — **every call** |
| Check the requested scope against the token's grant | Containment is decidable; ambiguity denies |
| Enforce per-tool rate limits (Note 01 §6) | |
| Hold and apply credentials the tool needs | The Executor never sees them |
| Record every invocation, granted or denied | §14 |
| Enforce the denial budget | §7 |

### The prompt is not the control

Note 01 §6 rule 4, restated because this is its enforcement point: the assembled context may *describe* the executor's constraints so the model behaves sensibly, but **the description is a courtesy and the broker is the boundary.** A model that ignores, misreads, or is steered past the description encounters an identical refusal. Nothing about enforcement is contingent on the model having understood anything.

---

## 5. Capability tokens

Minted by the kernel at dispatch from the `ResolvedExecutionSpec`'s `effective_capabilities` (Note 02 §7), which is already the intersection of Role profile, instance policy, and unit request (Note 04 §3).

```yaml
CapabilityToken:
  id:            TokenId
  attempt_id:    AttemptId              # bound to ONE attempt
  instance_id:   InstanceId
  workspace_ref: WorkspaceRef
  grants:
    - tool:      ToolId
      scope:     ScopeExpr              # logical roots only: workspace://, repo://
      mode:      read | write | execute
      rate_limit: RateSpec?
  denies:        [ToolId]               # always win
  issued_at, expires_at:  timestamp     # expiry ≤ attempt deadline
  spec_hash:     Hash                   # the spec this was derived from
```

**Rules**

1. **Bound to one attempt.** A retry mints a new token. A token cannot outlive the attempt that owns it.
2. **Expires no later than the attempt deadline.** A hung executor cannot hold live capability indefinitely.
3. **Scopes are logical roots** — `workspace://`, `repo://`, `artifact://` — never absolute host paths (Note 01 §6 rule 5). This is what makes the instance sandbox portable and the scope check decidable.
4. **The Executor may present the token; it may not read, modify, or reason about it.** It is opaque to the process that carries it.
5. **Denies always win**, at every layer, per Note 01 §6 rule 3.
6. **`spec_hash` binds the token to the approved configuration.** A token whose spec hash does not match the attempt's spec is refused — which is what stops a token from a differently-configured attempt being replayed.

---

## 6. The tool invocation contract

```yaml
ToolCall:                          # executor → broker
  seq, tool_id, args, token

ToolResult:                        # broker → executor
  seq
  outcome:  ok | denied | error
  value:    any?                   # ok
  denial:   DenialRecord?          # denied — see §7
  error:    ErrorRecord?           # error
```

**Three outcomes, and conflating any two is a defect:**

| Outcome | Meaning | Consumes attempt? | Kernel classification |
|---|---|---|---|
| `ok` | Executed, result returned | — | — |
| `denied` | **Policy refused it.** Nothing executed | No, until the budget is spent (§7) | `capability_denied` if budget spent |
| `error` | The tool itself faulted | **No** | `tool_error` — infrastructure, per Note 03 §4 |

The `denied` / `error` split matters for the same reason Note 03 §4 split `fail` from `error`: a refusal is a statement about *permission*, a fault is a statement about *infrastructure*, and treating either as the other sends the failure to the wrong place and burns the wrong budget.

---

## 7. The denial path ★

The design question nobody has answered yet: what does an executor experience when a capability check refuses it?

**A denial is data, not an error.**

```yaml
DenialRecord:
  tool_id, requested_scope
  reason:  not_granted | out_of_scope | rate_limited | explicitly_denied | token_expired
  granted_scopes: [ScopeExpr]      # what IS available — shown deliberately
  denial_ordinal: int              # nth denial this attempt
  budget_remaining: int
```

The refusal is returned to the executor **as a structured, legible result**, including the scopes that *are* available. A model that tried to read outside its worktree learns that it may read `workspace://**` and adapts. That is a good outcome, and hiding it would produce a confused loop that burns budget rediscovering the boundary.

### The denial budget

Repeated denials are not noise; they are a signal that **the unit's capability grant does not match its objective** — which is a planning error, not an execution error.

```
denial 1..N-1  → structured refusal returned; executor adapts
denial N       → executor terminated with `denial_budget`
               → Attempt.status = denied
               → FailureRecord.class = capability_denied
               → on_failure: escalate_human  (never retry)
```

**`capability_denied` escalates and never retries**, because a retry under an identical `ResolvedExecutionSpec` will hit the identical wall. The escalation carries the denied scopes and the granted scopes side by side, which is exactly the comparison a human needs — and satisfies Note 02 §13's requirement that an escalation pose a specific, answerable question ("this unit needs `db.read` on `analytics`; it was granted none. Widen the Role, narrow the objective, or reject?").

### Why not simply fail on first denial

Because the first denial is frequently the model probing an unfamiliar environment, and a single adaptive retry inside the same attempt is far cheaper than a failed attempt plus a fresh context compile. `N = 5` is a reasonable default. The budget exists so that adaptation cannot become an unbounded search of the permission surface.

---

## 8. The Model Broker

Note 03 §16 states that model gates reach the model "through the kernel's broker, not directly." That broker is specified here, and it applies to executors as well as gates.

**The Executor holds no model credentials.** It asks the broker.

| Responsibility | Why it cannot sit in the executor |
|---|---|
| Hold provider credentials | An executor is an untrusted loop over adversarial content (§11) |
| Meter tokens and cost | **A metered party may not report its own meter.** Note 02 §7's budgets are only real if measured at the boundary |
| Enforce the per-attempt budget, and halt on exhaustion | `fail_closed` (Note 02 §8) requires an enforcer outside the thing being limited |
| Resolve `tier` → concrete model via the binding table (A3) | Fleet/instance concern, not executor concern |
| Handle fallback across `candidates` and **record which model actually served** | Note 02 §6 `model_served` — the usual explanation for unexplained behaviour changes |
| Apply `sampling_class` → provider parameters | Portability (Note 01 §5) |

### The compounding security property ★

An executor with `network.egress: none` **and** no model credentials cannot reach the outside world at all — not even via the provider endpoint. Prompt-injected content in the workspace has no exfiltration path, because the one network-adjacent capability the executor genuinely needs is held by a different process.

This is why brokering the model matters beyond metering: without it, "no egress" would be a fiction, since the executor would necessarily hold a credential and a route to an external API.

---

## 9. Workspace lifecycle

Kernel-owned at every step except execution.

```
PROVISION   kernel   Ephemeral workspace from the pinned baseline commit.
                     Empty of credentials, history, and other units' state.
      │
EXECUTE     executor Sandboxed, time-bounded, brokered.
      │
FREEZE      kernel   Read-only at the instant the executor exits.
      │
HARVEST     kernel   §3 — diff, scope-check, construct, hash, validate.
      │
DISPOSE     kernel   Destroy on success; PRESERVE on failure/cancel/timeout.
```

**Rules**

1. **One workspace per attempt.** Never shared, never reused across attempts. A retry gets a fresh workspace from the same baseline — which is what makes `prior_attempt_evidence` (Note 02 §11) the *only* channel between attempts.
2. **Provisioned from a pinned commit**, never from a moving branch head. Replay (Note 02 §14) requires the baseline be reconstructible.
3. **Preserved on failure**, per Note 02 §13 — cancelled and timed-out work is inspectable but never merged, and its artifacts are `abandoned`, not `draft`.
4. **Concurrent workspaces cannot overlap in scope.** Enforced by the kernel's derived conflict edges (Note 02 §8) before provisioning, not by locking afterwards.
5. **Nothing survives disposal except harvested artifacts and recorded facts.** No caches, no scratch state, no "learnings."

---

## 10. The Sandbox contract

Note 03 §16 requires gates to run in a sandbox "at least as tight as executors" — a comparison with no referent until now. This is the referent.

```yaml
SandboxSpec:
  filesystem:
    roots:        [ {path_root, mode} ]   # read-only snapshot + one scratch path
    no_host_paths: true                   # logical roots only
  network:        none | allowlist        # `none` at MVP for executors AND gates
  credentials:    none                    # ALWAYS. Brokers hold credentials
  resources:      { cpu, memory, pids, disk_bytes }
  timeout:        enforced_externally     # the sandbox cannot extend its own deadline
  escape_surface:
    privileged:          false
    host_socket_access:  false
    device_access:       none
  determinism:    required | not_required # `required` for C0 gates (Note 03 §6)
```

| Consumer | Network | Credentials | Writes | Determinism |
|---|---|---|---|---|
| Executor | `none` | none | workspace + scratch | not required |
| C0 gate | `none` | none | scratch only | **required** |
| C1 gate | `none` | none | scratch only | not required |
| C2 gate | `none`¹ | none | scratch only | not required |

¹ C2 gates reach the model through the Model Broker (§8), not through their own egress.

**One `SandboxSpec` type serves executors and gates.** They differ only in parameters. This is deliberate: a verification component is not more trustworthy for being verification (Note 03 §16), and two sandbox implementations would inevitably diverge in strength.

---

## 11. Untrusted content posture

**Every byte inside the workspace is untrusted.** Source files, dependency manifests, vendored code, READMEs, issue text pulled into context, comments — all of it is potentially authored by someone who wants to steer the loop.

The design's position is not that injection can be prevented. It is:

> **Assume the model will eventually be steered. Bound what a steered model can accomplish.**

| Control | What it removes |
|---|---|
| `network.egress: none` | Exfiltration, remote fetch, C2 |
| No credentials in the executor (§8) | Credential theft; provider-endpoint exfiltration |
| Scope-checked tool calls (§4–6) | Reach beyond the worktree |
| Kernel-side harvest (§3) | Misreporting what was changed |
| `external_effects` all false (Note 04 §5) | Sending, deploying, spending |
| Ephemeral single-attempt workspace (§9) | Persistence across attempts |
| No memory write path (Note 05 §4) | Persistence across *units* — the durable one |
| Denial budget (§7) | Unbounded probing of the permission surface |
| Verification blind to executor narrative (Note 02 §5) | Talking the verifier into acceptance |

A fully steered executor's maximum achievable outcome is: **produce a bad diff in a throwaway workspace, which is then verified by components it cannot influence and merged only after a human approves.** That is the correct blast radius, and it is achieved by removing capability rather than by instructing the model.

---

## 12. What an Executor may never do

| Prohibited | Enforcement |
|---|---|
| Construct or submit its own artifact | Kernel-side harvest (§3) |
| Write `Attempt.status` or any verdict | Not in `ExecutorResult` (§2) |
| Report its own token or cost consumption | Metered at the Model Broker (§8) |
| Extend its own budget or deadline | Timeout enforced externally (§10) |
| Read, modify, or reason about its capability token | Opaque (§5 rule 4) |
| Hold any credential | Brokers hold them (§4, §8) |
| Reach the model provider directly | Model Broker (§8) |
| Reach the memory store | Disjoint source enumeration (Note 05 §7) |
| Read `private` artifact segments | Segment visibility (Note 02 §5) |
| Spawn WorkUnits or emit plans | Only `emits_plan` Roles produce a `TaskPlan`, and that is an artifact, not a dispatch |
| Mutate any existing artifact | Artifacts are immutable (Note 02 §4) |
| Persist anything past workspace disposal | §9 rule 5 |
| Write to config, policy, gates, or memory | Notes 01 §4, 03 §8, 04, 05 §4 |

---

## 13. Failure classification at the executor boundary

The kernel classifies. The executor only reports what happened.

| `termination` | Kernel classification | Consumes attempt? | Route |
|---|---|---|---|
| `completed` | — | Yes | Harvest → gates |
| `model_refused` | `spec_ambiguous` | Yes | Escalate — usually a specification problem |
| `deadline` | `timeout` | Yes | Retry or escalate per `on_failure` |
| `denial_budget` | `capability_denied` | Yes | **Escalate, never retry** (§7) |
| `tool_fault` | `tool_error` | **No** | Retry with backoff (Note 03 §4 logic) |
| `internal_error` | `tool_error` | **No** | Infrastructure. Never the unit's fault |

**`completed` does not mean success.** It means the loop ended without fault. Whether anything of value was produced is decided by harvest and gates, and an executor that terminates `completed` having changed nothing yields an empty diff that fails its criteria in the ordinary way.

---

## 14. Observability obligations

Every invocation is recorded, whatever its outcome, satisfying Note 02 §6 and §14's capture set.

```yaml
ToolCallRecord:
  seq, tool_id, args_hash, requested_scope
  outcome: ok | denied | error
  scope_decision: granted | denied
  denial_reason: DenialReason?
  result_hash: Hash?
  duration_ms

ModelCallRecord:
  seq, tier_requested
  model_served: ModelRef          # ACTUAL, including fallback
  sampling_params
  input_tokens, output_tokens, cost
  duration_ms
  outcome: ok | refused | error | budget_halt
```

Two things here are non-obvious and both matter:

- **Denied calls are recorded with equal fidelity to granted ones.** The denial stream is the highest-signal data the system produces about capability/objective mismatch, and it is invisible if only successes are logged.
- **`model_served` is per call, not per attempt.** Mid-attempt fallback to a secondary candidate is common under provider degradation and is very often the explanation for a behaviour change nobody can otherwise account for.

Feeds instrumentation amendment #3: denial rate per Role, fallback rate per tier, cost per attempt against the metered figure rather than a self-report.

---

## 15. Worked example

Continuing the password-reset case. `wu_102` attempt 1 (Note 03 §18), from the executor's side.

**Dispatch.** Kernel resolves `implementer@2.0.1`, mints:

```yaml
CapabilityToken:
  attempt_id: att_0102_1
  workspace_ref: ws_88f1
  grants:
    - { tool: "fs.read",    scope: "workspace://**",  mode: read }
    - { tool: "fs.write",   scope: "workspace://src/**", mode: write }
    - { tool: "shell.exec", scope: "workspace://",    mode: execute,
        rate_limit: { calls: 40, window_s: 600 } }
  denies: ["net.fetch", "db.write", "git.push"]
  expires_at: 2026-08-12T10:14:00Z          # = attempt deadline
```

**Workspace** `ws_88f1` provisioned from baseline `a91f3c2`. No credentials, no git remote configured, no network route.

**Execution excerpt.**

```
seq 1   fs.read  workspace://src/routes/auth/passwordReset.ts     → ok
seq 2   fs.read  workspace://src/middleware/rateLimit.ts          → ok
seq 7   net.fetch https://redis.io/docs/token-bucket
        → DENIED  reason: explicitly_denied
                  granted_scopes: [fs.read workspace://**, ...]
                  denial_ordinal: 1  budget_remaining: 4
seq 8   fs.read  workspace://node_modules/…/README.md             → ok
seq 14  fs.write workspace://src/routes/auth/passwordReset.ts     → ok
seq 15  fs.write workspace://src/config/limits.ts                 → ok
seq 19  shell.exec "npm test -- auth"                             → ok
```

Seq 7 is the interesting line. The model wanted documentation; egress is denied; it received a legible refusal listing what it *could* reach, adapted at seq 8 by reading the vendored README, and continued. **One denial, no failure, no escalation** — the budget exists for exactly this, and had it recurred four more times the attempt would have terminated `denial_budget` with a specific question for a human.

**Termination:** `completed`. `ExecutorResult` carries tool and model records and a private narrative. **No artifact, no verdict, no cost figures.**

**Harvest (kernel).** Workspace frozen; diff computed against `a91f3c2`: 3 files, +91/−4. All within `affected_paths` (`src/routes/auth/**`, `src/config/limits.ts`) — locality holds. `CodeDiff` artifact `diff_0212` constructed, hashed, provenance recorded, schema-validated.

**Then, per Note 03 §18:** stage 1 C0 gates pass; stage 3 `differential.response_equivalence` **fails** — the enumeration oracle. The executor never learns this. Attempt 2 runs in a *fresh* workspace from the same baseline, receiving only the structured `FailureRecord` (Note 02 §11) and none of attempt 1's narrative.

**Note what the executor could not do at any point:** report a diff other than the workspace's actual state; claim success; see its own cost; reach the network; hold a credential; or influence the verdict that rejected its work.

---

## 16. Challenges

### 16.1 Harvest cannot distinguish intent from accident

The kernel sees changed paths, not why they changed. A stray build artifact, a lockfile touched by a test run, or an editor backup file all appear as changes. Including them (§3) is correct — silent filtering would hide scope violations — but it produces false `locality` failures on noise.

Mitigation: baseline-relative ignore rules declared **in the workspace provisioning spec, not by the executor**, covering known-generated paths. Anything not in that declaration is a real change and is surfaced. The declaration is instance policy, reviewed, versioned, and not something the executor can extend.

This is genuinely imperfect and I expect it to be the most common source of early false failures.

### 16.2 The denial budget can mask an under-scoped unit as a model failure

An executor that burns five denials looks like a confused model, and the actual defect is usually that the plan granted the wrong capability. The escalation carries denied-vs-granted scopes side by side to make the real cause legible — but a human reading it quickly may still see "the agent kept trying to do something it shouldn't."

Mitigation: track **denial rate per Role per instance** (§14). A Role denied the same scope repeatedly across many units is a capability-profile defect, not a model defect, and only aggregate data shows that.

### 16.3 Sandbox strength versus cost

A VM per attempt is strong and expensive; a container is cheaper and weaker. The corpus assumes the executor is contained but never states how strongly, and §10 specifies the *contract* rather than the strength.

My position: containers with no network, no credentials, dropped capabilities, and read-only mounts are proportionate for a single-instance MVP where all code is the owner's own. Stronger isolation becomes necessary when instances are plural and untrusted relative to each other — the same threshold as C2b and C4.

### 16.4 The Model Broker is a bottleneck and a single point

Every model call in the system passes through it: executors, C2 gates, planners. It holds all provider credentials and enforces all budgets. Its failure halts everything, and its compromise is total.

I accept this. The alternative — distributing credentials to executors — trades a single well-guarded point for many untrusted ones, and it would falsify the §11 posture entirely.

### 16.5 Timeout during a tool call

A deadline kill mid-`fs.write` leaves a partially written file. Because the workspace is ephemeral and the attempt is `abandoned` (Note 02 §13), nothing partial is harvested and no artifact is produced — the corruption is discarded with the workspace.

This is safe **only because no tool has external side effects at MVP.** It is the concrete reason Note 04 §5 sets `external_effects` to false for every Role: with `may_send: true`, a timeout mid-send would be unrecoverable and undetectable.

---

## 17. Invariants

1. **The Executor holds no credentials of any kind** — not model, not repository, not secrets. All are held by brokers.
2. **The Tool Broker is the sole path from an Executor to any external effect**, and it verifies the capability token on *every* call.
3. **The artifact is derived from the workspace by the kernel, never reported by the Executor.**
4. **Out-of-scope changes are surfaced and flagged, never silently filtered.**
5. **An Executor never writes its own status, verdict, cost, or budget.**
6. **A capability token is bound to one attempt and expires no later than that attempt's deadline.**
7. **A denial is data, not an error.** It returns a structured refusal naming the granted scopes.
8. **`capability_denied` escalates and never retries** — a retry under the same spec meets the same wall.
9. **`denied`, `error`, and `ok` are three distinct outcomes** and conflating any two is a defect.
10. **All model calls pass through the Model Broker**, which meters them; a metered party never reports its own meter.
11. **One workspace per attempt**, provisioned from a pinned commit, never shared, never reused.
12. **Nothing survives workspace disposal** except harvested artifacts and recorded facts.
13. **One `SandboxSpec` type serves Executors and gates**; verification components are not more trusted for being verification.
14. **Every byte in the workspace is untrusted.** Controls remove capability; they do not instruct the model.
15. **Every tool invocation is recorded — denied ones with equal fidelity to granted ones.**
16. **`model_served` is recorded per call**, including fallback.

---

## 18. Deferred

| Item | Why |
|---|---|
| Container/VM technology and isolation implementation | §16.3 — a strength decision, not a contract decision |
| Tool implementations and the per-instance tool catalogue | Configuration, like the Role catalogue. The *contract* is Note 03 §8 (E4); tools are now registered, versioned, signed, and fixture-tested objects carrying an `effects` classification |
| **Evaluate AIOS (agiresearch) and MCP tooling as the implementation substrate for the Tool Broker (§4) and Model Broker (§8)** [E3] | AIOS provides multi-provider LLM adapters and MCP/VM sandboxing that overlap the *plumbing* of §4 and §8. It provides **no** capability-token enforcement, no per-attempt scoping, no metering suitable for `fail_closed` budgets, and no governance layer — all of which stay ours and sit above it. Its unit of work is **the agent-as-process**, which is incompatible with the WorkUnit model and must not be adopted anywhere. Maturity caveat: v0.2.2, Modes 3–4 ongoing. **Evaluate at implementation; do not design around it.** §17's invariants constrain any substrate we adopt rather than being relaxed by it |
| Model provider adapters | §8 defines the boundary; adapters are integration |
| Workspace provisioning mechanics (worktrees, copies, overlays) | Implementation |
| Ignore-rule vocabulary for §16.1 | Interacts with Note 08's path predicates; decide there |
| Streaming, partial results, interactive tools | Not needed for the MVP loop; would complicate harvest |
| Multi-executor collaboration on one unit | Deliberately not a thing. One attempt, one executor |

---

*End of Design Note 07.*

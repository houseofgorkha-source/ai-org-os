# AI-Org OS — Design Note 04
## Instance Policy and the Configuration Lattice

**Status:** Draft for review
**Scope:** Governance and configuration composition. No implementation, no storage decisions.
**Depends on:** Notes 01–03, and **amendments A1–A11 / B1–B8 as accepted constraints**
**Amendments:** New entries raised in `AMENDMENTS-pending.md` (C1–C5, `proposed`). The accepted block is untouched.

This note answers the question the original vision document opened with — *"each company has its own agents, memory, goals, permissions while sharing the underlying infrastructure"* — and makes "sharing" precise enough to build.

---

## Table of contents

1. [The boundary question](#1-the-boundary-question)
2. [The configuration lattice](#2-the-configuration-lattice)
3. [The three operations](#3-the-three-operations)
4. [The `InstancePolicy` schema](#4-the-instancepolicy-schema)
5. [Narrow: capability restriction](#5-narrow-capability-restriction)
6. [Oblige: gate and approval obligations](#6-oblige-gate-and-approval-obligations)
7. [Bind: the referent tables](#7-bind-the-referent-tables)
8. [Role admission](#8-role-admission)
9. [Class pipelines](#9-class-pipelines)
10. [Budget policy](#10-budget-policy)
11. [Attention policy — and a bug that only multi-instance reveals](#11-attention-policy--and-a-bug-that-only-multi-instance-reveals)
12. [Config channels and shared blast radius](#12-config-channels-and-shared-blast-radius)
13. [Isolation: structural, not policy](#13-isolation-structural-not-policy)
14. [The fleet floor and registry trust](#14-the-fleet-floor-and-registry-trust)
15. [Retention and instance lifecycle](#15-retention-and-instance-lifecycle)
16. [Policy validation at publication](#16-policy-validation-at-publication)
17. [Two instances, same Roles](#17-two-instances-same-roles)
18. [What must NOT be in `InstancePolicy`](#18-what-must-not-be-in-instancepolicy)
19. [Challenges](#19-challenges)
20. [New proposed amendments](#20-new-proposed-amendments)
21. [Deferred questions](#21-deferred-questions)

---

## 1. The boundary question

The premise of the whole system is that Roles, Gates, Recipes, Prompts, and Schemas are **shared OS assets**, and companies are **instances**. That premise only survives if there is a principled answer to:

> **What may an instance change, and what must it inherit?**

Get it wrong in one direction and every instance forks every Role to make one adjustment — at which point there is no OS, only N codebases with a shared ancestor. Get it wrong in the other and instances cannot differentiate, at which point multi-tenancy buys nothing.

The answer is not a list of overridable fields. It is a **direction**:

> **Shared OS config defines semantics and maxima.
> Instance policy may only restrict, add obligations, and supply referents.
> It may never widen, remove, or redefine.**

Everything in this note follows from that sentence.

---

## 2. The configuration lattice

Notes 02 and 03 introduced composition operators piecemeal — `intersect` for capabilities (A5), `union` for gates (A6), `min` for budgets. Those are not three rules. They are one rule at three levels.

```
        FLEET  (OS operator)
        · model tier bindings          · hard caps
        · gate registry (trust root)   · floor policy every instance must satisfy
        · instance provisioning        · principal attention budgets
                    │
                    │   narrow · oblige · bind      (never widen)
                    ▼
        INSTANCE  (company owner)
        · capability narrowing         · gate obligations
        · budget ceilings              · approver bindings
        · role admission               · repo / env / secret-scope bindings
        · class pipelines              · retention, channels
                    │
                    │   narrow · oblige · bind      (never widen)
                    ▼
        PLAN / WORKUNIT  (per-task)
        · requested capability subset  · additional criteria and gates
        · per-unit budget              · declared scope
                    │
                    ▼
        ResolvedExecutionSpec   (Note 02 §7 — flattened, hashed, frozen)
```

**One direction, three levels.** Each level may only make the effective configuration *more restrictive and more obligated* than the level above it. The `ResolvedExecutionSpec` is the fixed point at the bottom.

Two properties fall out, and both are worth more than they cost:

1. **Order independence.** Because every operation is monotonic, the composed result does not depend on the order layers are applied. You can add a layer without auditing the others (Note 03 §9 established this for gates; it generalises).
2. **A safety argument that survives configuration.** If the shared Role says a verifier cannot write, **no instance policy, no plan, and no work unit can make it writable.** The guarantee is structural rather than conventional, which means it holds even when policy is edited carelessly.

---

## 3. The three operations

Instance policy performs exactly three operations. Any policy expressing something outside these three fails validation.

### Narrow (intersect) — restricts what is possible

Applies to: capabilities, permissions, admitted roles, model tiers, egress allowlists.

```
effective = shared ∩ instance ∩ unit
```

A Role's `CapabilityProfile` is a **maximum**. Instance policy can subtract from it. It has no syntax for addition.

### Oblige (union) — adds what is required

Applies to: mandatory gates, required approvals, mandatory criteria, retention minimums.

```
effective = shared ∪ instance ∪ class ∪ unit
```

Conflicts resolve by **monotonic strengthening** (Note 03 §9): blocking beats advisory, stricter threshold wins, higher version wins.

### Bind (resolve) — supplies referents ★

Applies to: repositories, environments, secret scopes, approver principals, model tier bindings, notification targets.

This is the operation I had not named before, and it is the one that actually makes an instance an instance.

Shared config is deliberately **abstract**. A Role says `repository: worktree_write` — but *which* repository? A gate says `approver: ApproverSpec` — but *which human*? A Role says `tier: frontier` — but *which model*? The shared layer describes a shape; the instance supplies the referent.

**Bind is the dangerous operation.** Narrow and Oblige are monotonic and therefore structurally safe: the worst a bad Narrow can do is stop work, and the worst a bad Oblige can do is slow it. Bind is not monotonic, and it is not safe. Binding `repository` to a production repo instead of a sandbox is a colossal semantic difference expressed as one config string, and nothing about its *shape* is wrong.

Therefore bindings carry their own controls (§7): separate approval, typed referents, and validation that a binding resolves to a resource the instance is actually entitled to.

---

## 4. The `InstancePolicy` schema

```yaml
InstancePolicy:

  # ---- IDENTITY -------------------------------------------------------
  instance_id:      InstanceId
  version:          SemVer                # immutable once published
  name:             string
  owner:            HumanPrincipal        # accountable human for this instance
  status:           draft | active | suspended | archived
  fleet_floor_ref:  FloorPolicyRef        # the floor this policy must satisfy
  published_at:     timestamp?

  # ---- NARROW ---------------------------------------------------------
  capability_restrictions:
    - capability_profile_ref: ProfileRef  # which shared profile this narrows
      deny_tools:      [ToolId]
      restrict_scopes: { tool_id: ScopeExpr }    # may only shrink
      permission_caps:
        network:      { egress: none | allowlist, allowlist: [HostPattern] }
        repository:   { max_mode: none | read | worktree_write,
                        may_commit: bool, may_push: bool }
        data:         { max_access: none | read_replica | read_write }
        external_effects: { may_send: bool, may_deploy: bool, may_spend: bool }
  model_tier_cap:     frontier | standard | fast     # highest tier permitted

  # ---- OBLIGE ---------------------------------------------------------
  gate_obligations:
    - gate_ref:     GateId@SemVer
      blocking:     bool
      applies_when: PredicateExpr         # e.g. artifact.type == CodeDiff
      parameters:   {…}
  approval_obligations:
    - subject_kind: plan | artifact | merge | budget_increase | config_publication
      applies_when: PredicateExpr
      quorum:       QuorumSpec            # see C3 in §20
      approvers:    [PrincipalRef]
  criteria_obligations:                   # criteria forced onto every matching unit
    - applies_when: PredicateExpr
      criterion:    Criterion

  # ---- BIND -----------------------------------------------------------
  bindings:
    repositories:
      - logical: "primary"    concrete: RepoRef    default_branch: string
    environments:
      - logical: "test"       concrete: EnvRef
      - logical: "staging"    concrete: EnvRef
    secret_scopes:
      - logical: "ci"         concrete: SecretScopeRef
    approvers:
      - logical: "founder"    concrete: HumanPrincipal   # MUST be human
    model_tiers:                          # narrows the fleet binding table
      - tier: frontier        candidates: [ModelRef]     # ⊆ fleet candidates
    notification_targets:
      - logical: "escalation" concrete: ChannelRef

  # ---- ROLE ADMISSION -------------------------------------------------
  admitted_roles:                         # the relocated `delegates_to` (Note 01 §10)
    - role_ref:     RoleId@SemVer
      may_appear_in_plans: bool
      max_concurrent: int?

  # ---- CLASS PIPELINES ------------------------------------------------
  class_policy:
    - class:        WorkUnitClass
      enabled:      bool
      extra_gates:  [GateId@SemVer]
      promotion_rules: [PredicateExpr]    # e.g. mechanical touching auth ⇒ contract

  # ---- BUDGET ---------------------------------------------------------
  budget_policy:
    per_work_unit_cap:   { execution: Money, verification: Money }
    per_plan_cap:        Money
    per_day_cap:         Money
    concurrency:
      max_running_units: int
      max_model_gate_units: int
    exhaustion:          fail_closed      # only permitted value

  # ---- ATTENTION ------------------------------------------------------
  attention_policy:
    max_open_escalations:     int
    max_pending_approvals:    int
    max_escalations_per_hour: int
    batch_window:             Duration
    auto_pause_on_breach:     bool        # default true
    # NOTE: enforced against the PRINCIPAL's fleet budget, not just here (§11)

  # ---- CONFIG CHANNEL -------------------------------------------------
  config_channel:
    channel:        stable | canary | pinned
    pins:                                 # channel == pinned
      roles:        [RoleId@SemVer]
      gates:        [GateId@SemVer]
      recipes:      [RecipeId@SemVer]
    max_lag:        Duration?             # how far behind stable it may sit

  # ---- RETENTION ------------------------------------------------------
  retention:
    audit_horizon:        Duration        # artifacts, manifests, specs, approvals
    trace_horizon:        Duration        # private reasoning traces (shorter)
    config_versions:      never_deleted   # only permitted value
```

---

## 5. Narrow: capability restriction

```
effective_capabilities = Role.CapabilityProfile
                       ∩ InstancePolicy.capability_restrictions
                       ∩ WorkUnit.requested
```

Validation rules:

1. **`restrict_scopes` may only shrink a scope.** `workspace://src/**` narrowing `workspace://**` is valid; the reverse fails validation. Scope containment is decidable, so this is a static check.
2. **`permission_caps` may only lower.** `max_mode: read` against a Role's `worktree_write` is valid. `worktree_write` against a Role's `read` fails validation, even though it looks like a harmless upgrade — because if it were permitted once, the direction of the whole lattice is gone.
3. **`deny_tools` is unconditional** and cannot be overridden by any lower layer (Note 01 §6 rule 3, unchanged).
4. **`model_tier_cap` narrows tier**, which is how a cost-constrained instance runs the same Roles on cheaper models without forking a single Role definition.

**There is no `capability_grants` field, and there never will be.** An instance that needs a capability its Role does not have is asking for a different Role — a change that is visible, reviewed, and shared.

---

## 6. Oblige: gate and approval obligations

```
effective_gates = Role.GateProfile ∪ Instance.gate_obligations
                ∪ class.extra_gates ∪ WorkUnit.additional
```

This is where a company differentiates most cheaply. Adding a licence-compliance gate to every `CodeDiff` across the instance is four lines of policy and touches no Role:

```yaml
gate_obligations:
  - gate_ref: "gate://license.compatible@2.0.0"
    blocking: true
    applies_when: "artifact.type == CodeDiff"
```

`criteria_obligations` is the stronger version: it forces a **criterion** onto every matching unit, which means the obligation is visible in the unit's contract and in its `FailureRecord`, not merely in the gate list. Use it when the requirement is part of what "done" means rather than a check bolted on afterwards.

**No removal syntax exists at any level.** Per Note 03 §9, an instance that genuinely should not run a gate must have that reflected in the shared Role, the class, or the gate's `applies_when` — all of which are reviewed, attributable changes. The absence of an exemption field is deliberate and is the single most important thing preventing policy from becoming the place governance goes to die.

---

## 7. Bind: the referent tables

Bindings resolve abstract references in shared config to concrete resources in this instance.

| Logical | Bound to | Why abstract in shared config |
|---|---|---|
| `repository: "primary"` | A concrete repo + default branch | Roles are repo-agnostic; a shared Role cannot name a company's repo |
| `environment: "test"` | A concrete environment | C1 gates need somewhere to run; the runner is per-instance |
| `secret_scope: "ci"` | A named scope, **never a literal** | Note 01 §7 |
| `approver: "founder"` | A **human principal** | Gates name roles like "the person who approves architecture"; the person is per-instance |
| `model_tier: frontier` | A candidate list ⊆ fleet's | A3: fleet owns the binding, instance may narrow |
| `notification: "escalation"` | A channel | Where escalations surface |

### Controls on Bind, because it is not monotonic

1. **Typed referents.** A binding must resolve to a registered resource of the declared type. No free strings.
2. **Entitlement check.** The instance must be entitled to the resource at the fleet layer. An instance cannot bind a repository it was not provisioned with, which is what prevents Bind from becoming a cross-instance reach.
3. **`approvers` must resolve to human principals**, validated at publication. ★ This is the publication-time enforcement of Note 02 §12 invariant 3. Without it, an instance could bind an automated principal and every human gate in the system silently becomes a no-op — the cheapest possible defeat of the entire approval model, and it would look like a configuration typo.
4. **Binding changes require their own approval**, separate from the rest of the policy. Changing `repository: "primary"` from a sandbox to production is a governance event, not a config tweak, and it should not ride along in a policy version that also adjusts a budget.
5. **`model_tiers` candidates must be a subset of the fleet binding** for that tier. Narrow only.

---

## 8. Role admission

The relocation promised in Note 01 §10. `delegates_to` does not exist on `Role`; **which Roles may appear in a plan is instance policy.**

```yaml
admitted_roles:
  - { role_ref: "planner@1.0.0",     may_appear_in_plans: false, max_concurrent: 1 }
  - { role_ref: "architect@1.2.0",   may_appear_in_plans: true,  max_concurrent: 2 }
  - { role_ref: "implementer@2.0.1", may_appear_in_plans: true,  max_concurrent: 4 }
  - { role_ref: "verifier@1.1.0",    may_appear_in_plans: false, max_concurrent: 4 }
```

Notes on the example:

- `planner` has `may_appear_in_plans: false` — a plan cannot schedule another planner. This is the cycle guard for planning specifically, enforced by admission rather than by graph analysis.
- `verifier` is admitted but not plan-schedulable, because after Note 03 §1 verification is never a plan node. It is reached through gate execution, and admission still governs whether it may run at all.
- `max_concurrent` is per-Role, which is how you stop a wide plan from spawning twelve simultaneous frontier-model implementers.

**Kernel validation** (extending Note 02 §9 step 2): every `role_ref` in a submitted `TaskPlan` must be admitted with `may_appear_in_plans: true`. A plan naming an unadmitted Role fails validation before any node runs.

---

## 9. Class pipelines

Note 02 §17.1 introduced `WorkUnitClass`. Instance policy binds classes to obligations and, critically, to **promotion rules**.

```yaml
class_policy:
  - class: mechanical_change
    enabled: true
    extra_gates: []
    promotion_rules:
      - "diff.touches(path: 'src/auth/**')        ⇒ contract_change"
      - "diff.touches(path: '**/migrations/**')   ⇒ contract_change"
      - "diff.modifies_public_interface           ⇒ contract_change"
      - "diff.files_touched > 5                   ⇒ bounded_change"
  - class: contract_change
    enabled: true
    extra_gates: ["gate://security.review@1.4.0"]
```

**Promotion rules are the enforcement of Note 02 §17.1's central claim** — that a unit's class is a *claim the kernel checks against the actual diff*, not a self-assessment. The rules are per-instance because the sensitive surface is per-company: one company's `src/auth/**` is another's `src/billing/**`.

Promotion happens **after execution, before verification**: the diff exists, the kernel evaluates the rules against it, and if promoted, the unit acquires the stricter class's gates before anything is accepted. A promoted unit does not re-execute; it gets verified harder.

Promotion rules are expressed in the predicate language (Note 08), evaluated on the artifact fact surface. `unknown` resolves to **promote** — when in doubt, be stricter.

### Coverage validation  [C5]

A promotion rule whose paths have been renamed does **not** evaluate to `unknown`. The fact surface resolves perfectly and `diff.paths` simply does not match: it returns `false`, correctly, forever, and the autonomy guard is silently gone. Runtime logic cannot catch this.

Therefore promotion rules are validated by **static coverage analysis** (Note 08 §7):

1. **At policy publication** — every glob or prefix literal in the expression is checked against the bound repository.
2. **Re-evaluated on repository change** — because the motivating scenario is a subsystem renamed *months after* publication. Publication-time validation alone would not have caught the case this amendment exists for.
3. A predicate term matching zero files is an instance **health signal**, not a gate failure — a path may be legitimately unused, and failing dispatch on it would be disproportionate. A term matching zero files for a threshold period **escalates to the policy owner**.

Registered as Appendix A measure 10. Note the pairing: `unknown` means the language could not resolve a fact; `ZERO_COVERAGE` means it resolved fine and can never fire. Two mechanisms, neither substituting for the other.

---

## 10. Budget policy

```
effective_budget = min(Role.budget_defaults,
                       Instance.budget_policy,
                       Plan.remaining,
                       Fleet.hard_cap)
```

Four caps, `min()` across all of them, `fail_closed` the only exhaustion policy (Note 02 §8, unchanged).

`per_work_unit_cap` splits execution from verification per B7, so a runaway model gate cannot starve the work it is judging. Concurrency limits are here rather than in the plan because Note 02 §8 rule 4 put fan-out under instance control — a 40-node plan does not get to decide it deserves 40 executors.

`per_day_cap` is the circuit breaker that matters operationally. An instance that hits it stops dispatching and escalates. That is a bad afternoon; the absence of it is a bad month discovered at invoicing.

---

## 11. Attention policy — and a bug that only multi-instance reveals ★

Note 02 §13 put attention limits on the instance. **That is wrong, and it is only visibly wrong once instances are plural.**

Attention is a property of a **human**, not of an instance. A founder who owns three instances, each correctly configured with `max_open_escalations: 5`, faces fifteen simultaneous escalations — every one of them within policy, and the human is drowning exactly as Note 02 §13 warned. The policy is satisfied and the property it was protecting is gone.

**The fix: attention budgets are enforced against the principal, aggregated across every instance they are bound to.**

```yaml
# FLEET layer
PrincipalAttentionBudget:
  principal:                "human:founder"
  max_open_escalations:     8      # ACROSS ALL INSTANCES
  max_pending_approvals:    12
  max_escalations_per_hour: 6
  on_breach:                pause_dispatch_by_priority
```

Instance policy may only **narrow** this — an instance can be quieter than the principal's global budget, never louder. When the principal-level budget breaches, dispatch pauses across every instance bound to that principal, lowest-priority instance first.

This is the third distinct case in the design where a guarantee that looks fine per-object dissolves under aggregation, and I would treat that as a general lesson worth carrying into the remaining notes: **check every limit against the resource it actually protects, not against the object it is written on.**

Raised as amendment **C1** (§20).

---

## 12. Config channels and shared blast radius ★

The premise says shared config. The consequence is that **a bad Role version affects every instance simultaneously**, which is a failure mode no single-tenant design has.

```yaml
config_channel:
  channel: stable | canary | pinned
  pins: { roles: [...], gates: [...], recipes: [...] }
  max_lag: 30d
```

| Channel | Behaviour | For |
|---|---|---|
| `canary` | Receives new shared config versions first | One or two low-stakes instances, by consent |
| `stable` | Receives config after canary soak | Default |
| `pinned` | Explicit versions; opts out of rollout entirely | Regulated or high-stakes instances |

`max_lag` prevents a pinned instance from drifting years behind and quietly becoming an unmaintained fork — the failure mode that would hollow out the "OS is the product" premise from the inside.

**Rollout of a shared config version is a fleet operation with staged exposure**, not an edit that takes effect everywhere at once. This is the multi-instance equivalent of a deploy, and it deserves the same discipline: canary, soak, promote, and the ability to roll back by re-pinning.

Note the interaction with Note 02 §7: because a `ResolvedExecutionSpec` is flattened and frozen at dispatch, **in-flight work is unaffected by a config rollout mid-flight**. Rollout changes what the *next* unit resolves to. That property was designed for replay and turns out to pay for itself again here.

---

## 13. Isolation: structural, not policy ★

The most important thing in this note is a field that does not exist.

> **`InstancePolicy` contains no field that names another instance.**
> Not an allowlist, not a share, not a federation setting, not a read-only reference.

Same shape as Note 01 §10's refusal of `delegates_to`: **a policy that cannot name another instance cannot leak to one.** If cross-instance access were expressible in policy — even as a field that is always `false` — then isolation would depend on policy handling being correct, and a bug in policy composition would become a data breach. Instead, isolation is enforced by a layer with **no configuration surface at all**.

| Dimension | Enforced where | Configurable? |
|---|---|---|
| Data scope (`instance_id` on every row) | Below the application layer | **No** |
| Credentials / secret scopes | Fleet provisioning | Bindings only, entitlement-checked |
| Execution workspace | Container / worktree per instance | **No** |
| Budget accounting | Kernel, per instance, no borrowing | Caps only |
| Memory stores | Per instance (Note 05) | **No** |
| Config (Roles, Gates, Recipes) | Shared, **read-only** | Channel and pins only |

Shared config is the *only* thing that crosses instances, it is read-only, and it contains no company data by construction — which is exactly why the "what may live in policy" boundary in §18 matters.

---

## 14. The fleet floor and registry trust

### The fleet floor

Every instance policy must satisfy a **floor policy** at the fleet layer — a minimum set of obligations no instance may fall below.

```yaml
FloorPolicy:
  mandatory_gates:      ["gate://artifact.schema_valid@1.0.0",
                         "gate://secrets.absent@2.0.0"]
  mandatory_approvals:  [{ subject_kind: merge }, { subject_kind: config_publication }]
  forbidden_permissions: { external_effects: { may_spend: true } }
  max_model_tier:       frontier
  min_retention:        { audit_horizon: 90d }
```

The floor is what makes §19.1's "instance shopping" attack non-trivial: provisioning a new, laxer instance cannot get below the floor, because the floor is checked at publication of every instance policy.

### Registry trust (Note 03 §19.5)

Note 03 asserted the gate registry is the trust root and left it protected only by "humans only." At single-instance MVP that is proportionate. Multi-instance it is not, because one registry now governs every company simultaneously.

Fleet-layer protections, raised as amendment **C2**:

- Gate definitions are **signed**; the kernel verifies signatures before execution.
- Registration and version promotion require **two-person approval** at fleet level.
- The registry has its own append-only audit log, outside any instance's reach.
- **No instance policy may reference an unsigned or unregistered gate.**

---

## 15. Retention and instance lifecycle

```
provisioning ──► active ──► suspended ──► archived
                    │            │
                    └────────────┘        (resumable)
```

| State | Dispatch | In-flight | Reads | Replay |
|---|---|---|---|---|
| `active` | Yes | Runs | Yes | Yes |
| `suspended` | **No** | Runs to completion or cancels per policy | Yes | Yes |
| `archived` | **Never** | None | Read-only | **Yes — must remain possible** |

`archived` is the terminal state. Archival must preserve everything Note 02 §14 mode 1 and mode 2 replay require: artifacts, manifests, resolved specs, gate results, approvals, and the config versions they pinned. `config_versions: never_deleted` is not an instance choice — deleting a version breaks replay for every instance that pinned it, so it is a fleet invariant.

**Hard deletion is deliberately not a runtime operation.** Where legal or contractual obligation requires it, it is a fleet-level procedure with explicit human authorisation, and it should be understood plainly: it destroys the audit trail it touches, and replay for that instance ends. That is sometimes the correct outcome; it is never a side effect.

`trace_horizon` is shorter than `audit_horizon` by design (Note 02 §14): private reasoning traces are the bulk of the volume and the least reusable, and their expiry degrades human debugging without breaking either replay mode.

---

## 16. Policy validation at publication

Deterministic, complete, and run before a policy version can become `active`. A policy is production governance, so it is gated like one.

```
1. STRUCTURAL      · schema-valid; version increments; owner is a human principal

2. DIRECTION ★     · every capability_restriction only NARROWS its target profile
                   · every permission_cap is ≤ the shared profile's value
                   · every model_tier candidate set ⊆ the fleet binding
                   · NO gate removal, NO capability grant, NO role redefinition
                     appears anywhere in the document

3. FLOOR           · every FloorPolicy mandatory gate present in the effective set
                   · every FloorPolicy mandatory approval present
                   · no forbidden permission enabled
                   · retention ≥ floor minimums

4. BINDINGS        · every logical name referenced by an admitted Role is bound
                   · every referent resolves and is entitlement-checked
                   · every approver resolves to a HUMAN principal   ★
                   · no binding names a resource of another instance

5. REFERENCES      · every role_ref, gate_ref, recipe_ref resolves and is `active`
                   · pinned versions exist and are not `retired`
                   · every gate is registered and signed (C2)

6. COHERENCE       · every admitted Role's capability needs are satisfiable after narrowing
                   · every admitted Role's recipe layers have bound sources
                   · every class with enabled: true has a satisfiable pipeline
                   · promotion rules reference resolvable path predicates

7. ATTENTION       · instance limits ≤ the principal's fleet budget (C1)

8. APPROVAL        · human approval of this policy version, bound to its content hash
                   · separate approval for any changed BINDING (§7 control 4)
```

Step 2 is the one that enforces the lattice, and it is worth noting that it is a **static, whole-document check**: the validator does not need to simulate execution to prove the direction holds. That is the practical payoff of choosing a monotonic composition model.

Step 6 catches the failure that would otherwise appear as a mysterious runtime stall: an instance that narrows away a capability an admitted Role requires produces Roles that can never complete a unit. Caught at publication, it is a one-line error message.

---

## 17. Two instances, same Roles ★

The concrete demonstration that the premise works. Both instances run **identical shared config** — same `architect@1.2.0`, `implementer@2.0.1`, `verifier@1.1.0`, same recipes, same gate registry. Nothing is forked.

### Instance A — early-stage product company

```yaml
instance_id: "northstar"
owner: "human:founder"
capability_restrictions:
  - capability_profile_ref: "capprofile://code_writer/1.1.0"
    permission_caps: { repository: { may_push: false } }
model_tier_cap: frontier
gate_obligations: []
approval_obligations:
  - { subject_kind: merge, quorum: "1 of 1", approvers: ["human:founder"] }
admitted_roles: [architect, implementer, verifier, planner]
class_policy:
  - class: mechanical_change
    enabled: true
    promotion_rules: ["diff.modifies_public_interface ⇒ contract_change"]
budget_policy: { per_work_unit_cap: {execution: $8, verification: $4}, per_day_cap: $200 }
attention_policy: { max_open_escalations: 5, auto_pause_on_breach: true }
config_channel: { channel: canary }
retention: { audit_horizon: 90d, trace_horizon: 14d }
```

### Instance B — regulated financial services

```yaml
instance_id: "meridian"
owner: "human:cto"
capability_restrictions:
  - capability_profile_ref: "capprofile://code_writer/1.1.0"
    deny_tools: ["shell.exec"]                      # no arbitrary execution
    permission_caps:
      repository: { may_push: false, may_commit: true }
      network:    { egress: none }
      data:       { max_access: none }
model_tier_cap: standard                            # no frontier tier: data policy
gate_obligations:
  - { gate_ref: "gate://license.compatible@2.0.0",   blocking: true }
  - { gate_ref: "gate://pii.absent@3.1.0",           blocking: true }
  - { gate_ref: "gate://audit.change_record@1.0.0",  blocking: true }
criteria_obligations:
  - applies_when: "artifact.type == CodeDiff"
    criterion: { id: "reg1", class: C0,
                 statement: "Change record references an approved ticket.",
                 check: { gate_ref: "gate://audit.change_record@1.0.0" } }
approval_obligations:
  - { subject_kind: merge, quorum: "2 of 3",
      approvers: ["human:cto","human:head-eng","human:compliance"] }
  - { subject_kind: artifact, applies_when: "artifact.type == ArchitectureDecision",
      quorum: "2 of 2", approvers: ["human:cto","human:compliance"] }
admitted_roles: [architect, implementer, verifier]   # NO planner — humans plan here
class_policy:
  - class: mechanical_change
    enabled: false                                   # every change is reviewed
  - class: contract_change
    extra_gates: ["gate://security.review@1.4.0"]
budget_policy: { per_work_unit_cap: {execution: $3, verification: $6}, per_day_cap: $400 }
attention_policy: { max_open_escalations: 3, max_escalations_per_hour: 2 }
config_channel: { channel: pinned, pins: {...}, max_lag: 90d }
retention: { audit_horizon: 7y, trace_horizon: 1y }
```

### What this demonstrates

| | Northstar | Meridian |
|---|---|---|
| Shared Role definitions | identical | identical |
| Gates on a `CodeDiff` | Role profile only | Role profile **+ 4 obligations** |
| Merge approval | 1 of 1 | **2 of 3** |
| Autonomy floor | `mechanical_change` runs unreviewed | **disabled** — nothing is unreviewed |
| Model tier | frontier | standard (data policy) |
| Planning | agent-planned | **human-planned** (planner not admitted) |
| Verification spend | less than execution | **more than execution** |
| Config exposure | canary | pinned, 90d lag |

Meridian is a materially more conservative company, and **not one shared asset was forked to express it.** Everything is Narrow, Oblige, and Bind. That is the multi-instance premise actually working — and note that Meridian is *stricter* in every dimension, which is the only direction the lattice permits. There is no policy Meridian could write that makes it *looser* than Northstar's shared inheritance.

---

## 18. What must NOT be in `InstancePolicy`

| Field | Why it must not exist |
|---|---|
| **Any reference to another instance** | §13. A policy that cannot name another instance cannot leak to one. |
| `capability_grants` / any widening | Inverts the lattice. The one change that would invalidate every safety argument in Notes 01–04. |
| Gate exemptions / `disable_gate` | Note 03 §9. This is where governance would go to die, and its absence is load-bearing. |
| **Prompt overrides** | ★ If instances could override prompts, Roles stop being shared and you have N forks with a common ancestor. The single fastest way to destroy the OS premise. |
| Model *candidate* additions | A3: the fleet owns the binding. Instances narrow, never extend. |
| Non-human approver bindings | §7 control 3. Defeats every human gate at once and looks like a typo. |
| Literal secrets | Scopes only (Note 01 §7). |
| Runtime state (spend to date, open units, current tasks) | Projections over the event log. Config that mutates at runtime is not config. |
| Learned or auto-tuned values | Nothing writes to policy at runtime (Note 01 §4). |
| **Company knowledge, product context, market information** | ★ That is *memory*, not policy. See below. |
| Role or gate *definitions* | Shared assets. An instance needing a different Role needs a shared Role, reviewed. |

### The governance/knowledge boundary ★

The most tempting mistake in this document's subject area: putting *what the company is* into instance policy.

> **`InstancePolicy` governs what may happen. Memory informs what should be built.**

- *"Acme is a B2B logistics platform; the core entity is a Shipment"* → **memory**. It shapes what gets designed.
- *"Acme requires two-person approval on schema changes"* → **policy**. It constrains what may proceed.

The test is direction: policy **constrains**, memory **informs**. Mixing them means governance is edited every time the business is described, and business knowledge acquires approval ceremony it does not need. It also breaks §13's cleanest property — that shared and policy layers contain no company data — and would make policy a second, unaudited memory store with none of Note 05's write rules.

---

## 19. Challenges

### 19.1 Instance shopping ★

Monotonic composition prevents an instance from weakening its own governance. It does not prevent **provisioning a new instance with laxer policy and moving the work there** — the multi-tenant equivalent of forum shopping, and it is the most likely way this design is defeated in practice, because every step of it looks legitimate.

Two mitigations, both necessary:

1. **The fleet floor** (§14) — a minimum no instance can go below, checked at every policy publication.
2. **Instance provisioning is itself a gated human decision at fleet level**, with a stated purpose. Instances are not self-service.

Neither is sufficient alone. A founder who owns the fleet can lower the floor, and no technical control fixes that — nor should it pretend to. What the design can do is make the weakening **visible, attributable, and versioned**, so it is a decision on the record rather than a quiet configuration drift. That is the honest ceiling of governance for a system whose owner is also its principal.

### 19.2 Bind is the soft spot

Narrow and Oblige are monotonic and therefore safe under carelessness. Bind is neither. Every binding is a string that looks like every other string, and `repository: "primary" → <production>` is one edit away from `<sandbox>`. §7's controls (typed referents, entitlement checks, separate approval) are the mitigation, and I rate them as adequate-not-strong. If one part of this design causes a real incident, my prediction is that it is a binding.

### 19.3 Policy versioning will lag reality

Instance policy is immutable-and-versioned like everything else, which is correct for replay and irritating in operation. Raising a day cap during an incident means publishing a policy version with human approval — exactly when nobody wants ceremony.

I still would not add an emergency override path, because an override path is what gets used routinely within a month. The correct pressure valve is **narrow, expiring, human-approved amendments to a specific budget** (the mechanism Note 02 §7 rule 5 already defines for budget increases), not a general policy bypass.

### 19.4 The floor is a fleet-level single point

Everything in §14 depends on the fleet floor being correct and on the registry being trustworthy. There is one floor and one registry for all instances. That is the price of a shared OS, and it means fleet-layer changes deserve *more* ceremony than instance-layer changes, not less — which is the opposite of how config systems usually evolve, where the top layer becomes the convenient place to make things work.

### 19.5 Class pipelines make autonomy configurable, which cuts both ways

`mechanical_change` with `enabled: true` and permissive promotion rules is the autonomy dial for the entire system, expressed as instance policy. An instance can set it wide. The promotion rules are the guard, and they are per-instance path predicates — which means **the quality of the autonomy guarantee is exactly the quality of one company's path globs**. A team that reorganises `src/auth/**` to `src/identity/**` and forgets the promotion rule silently loses the protection.

Partial mitigation: promotion rules should be validated against the actual repository at policy publication (do the referenced paths exist?), and a path predicate matching zero files should be a warning. Raised as amendment **C5**.

---

## 20. New proposed amendments

Added to `AMENDMENTS-pending.md` as `proposed`. **The accepted A/B block is untouched.**

| # | Target | Change | From |
|---|---|---|---|
| C1 | Note 02 §13 | Attention limits are enforced against the **principal**, aggregated across instances, with instance policy only narrowing. Add `PrincipalAttentionBudget` at fleet layer. | §11 |
| C2 | Note 03 §19.5 | Fleet registry protections: signed gate definitions, two-person registration approval, registry audit log outside instance reach, no policy may reference an unsigned gate. | §14 |
| C3 | Note 02 §12 | `Approval` gains `quorum` (`N of M`) with a named approver set. Single-approver is the degenerate `1 of 1` case. | §4, §17 |
| C4 | Note 01 §13 | Instance model gains the **fleet layer** explicitly: floor policy, model tier bindings, provisioning, principal attention budgets, registry trust. | §2, §14 |
| C5 | Note 04 §9 | Class promotion rules are validated against the bound repository at policy publication; a predicate matching zero paths is a warning. | §19.5 |

---

## 21. Deferred questions

1. ~~**Memory stores — the four stores**~~ — **RESOLVED and CORRECTED**, Note 05 [D1]. §18's governance/knowledge boundary is implemented there. Not four stores; five advisory *kinds*. `memory_policy` on `InstancePolicy` is **deferred to instance #2** (D7).
2. **`SelectorExpr` / `PredicateExpr` grammar** — open since Note 01, and now larger: it must express recipe selectors, `applies_when` predicates, and class promotion rules. Possibly three grammars, possibly one. Worth deciding deliberately rather than by accretion.
3. **Fleet layer specification** — sketched here (C4), not specified. Floor policy, provisioning, tier bindings, principal budgets, registry protections.
4. **`TaskPlan` artifact schema** — still informal across three notes. Simpler now that verification nodes are gone.
5. **Criteria-quality gate** — Note 02 §17.2. Still open, still the ceiling.
6. **Storage, event log, kernel architecture** — still last. Four notes in, the model has not been shaped by a database.

---

*End of Design Note 04.*

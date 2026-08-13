# AI-Org OS — Design Note 01
## The Role Schema and the Context Recipe Model

**Status:** Draft for review
**Scope:** Data model only. No implementation, no kernel design, no storage decisions.
**Purpose:** Establish the cleanest possible definition of "a role" and "the context a role gets" before any code exists.

Schemas below are written in a neutral declarative notation. It is a *data model*, not an implementation. Types are annotated for precision, not to imply a language.

---

## Table of contents

1. [Where `Role` sits in the system](#1-where-role-sits-in-the-system)
2. [The complete `Role` schema](#2-the-complete-role-schema)
3. [Field-by-field rationale](#3-field-by-field-rationale)
4. [Configuration vs runtime state](#4-configuration-vs-runtime-state)
5. [Model configuration](#5-model-configuration)
6. [Tool and capability configuration](#6-tool-and-capability-configuration)
7. [Permission boundaries](#7-permission-boundaries)
8. [Budget limits](#8-budget-limits)
9. [Acceptance and verification configuration](#9-acceptance-and-verification-configuration)
10. [Supervisor and delegation relationships](#10-supervisor-and-delegation-relationships)
11. [Versioning](#11-versioning)
12. [The `ContextRecipe` schema](#12-the-contextrecipe-schema)
13. [The three initial recipes](#13-the-three-initial-recipes)
14. [How the Context Compiler builds a context](#14-how-the-context-compiler-builds-a-context)
15. [Worked example: one Work Unit end to end](#15-worked-example-one-work-unit-end-to-end)
16. [What must NOT be in the `Role` schema](#16-what-must-not-be-in-the-role-schema)
17. [Deferred questions](#17-deferred-questions)

---

## 1. Where `Role` sits in the system

Four core types. Two are configuration, two are runtime.

```
CONFIGURATION (human-authored, versioned, immutable once published)
  Role            — how a class of work is executed
  ContextRecipe   — what information that work is allowed to see

RUNTIME (machine-generated, append-only, instance-scoped)
  WorkUnit        — one concrete piece of work to be done
  Artifact        — the typed output a WorkUnit produced
```

The relationship, stated precisely:

> A **WorkUnit** names a **Role** at a pinned version. The Role names a **ContextRecipe** at a pinned version. The Context Compiler executes the recipe against the current world state to produce a **ContextManifest**. An executor runs the model with that context and the Role's capabilities, and emits an **Artifact**. Gates declared by the Role and the WorkUnit accept or reject the Artifact.

A Role is a *noun that describes a how*, not an actor. It has no lifetime, no inbox, no memory, no state. Ten thousand WorkUnits can reference the same Role version concurrently and none of them can affect each other.

**The legitimacy test for any Role** (carried forward from prior discussion):

> A Role is legitimate only if it differs from every other Role in at least one **mechanically enforced** dimension — tools, permissions, context recipe, model tier, or mandatory gates. If two Roles differ only in prompt text, they are one Role wearing two hats. Merge them.

---

## 2. The complete `Role` schema

```yaml
Role:

  # ---- IDENTITY -------------------------------------------------------
  id:                 RoleId          # stable slug, never changes: "architect"
  version:            SemVer          # "1.4.0" — immutable once published
  name:               string          # human display: "Architect"
  mandate:            string          # ONE sentence: the class of work this Role does
  description:        string          # longer prose, for humans only
  status:             enum            # draft | active | deprecated | retired
  supersedes:         RoleRef?        # previous version this replaces
  owner:              string          # human accountable for this Role definition
  created_at:         timestamp
  published_at:       timestamp?      # null while draft; set once, then immutable

  # ---- CONTRACT -------------------------------------------------------
  consumes:           ArtifactType[]  # input artifact types this Role can accept
  produces:           ArtifactType    # THE artifact type this Role emits (exactly one)
  emits_plan:         bool            # may this Role emit a TaskPlan artifact?

  # ---- MODEL ----------------------------------------------------------
  model:                              # SEMANTICS only. Role declares what the work
    tier:             enum            # needs; the binding to concrete models is
                                      # resolved elsewhere.  [A3]
    pinning:          enum            # pinned | floating_within_tier
    reasoning_effort: enum            # low | medium | high | max
    sampling_class:   enum            # deterministic | balanced | exploratory
    max_output_tokens: int
    # `candidates` REMOVED [A3]. Tier resolves to an ordered candidate list via a
    # binding table owned above the Role. See §5. The binding table object itself
    # is DEFERRED to instance #2 (C4); at MVP a single instance-level table serves,
    # read through a resolver seam so nothing reads it from the instance directly.

  # ---- CONTEXT --------------------------------------------------------
  context:
    recipe:           ContextRecipeRef      # id + pinned version
    budget_tokens:    int                   # hard ceiling for assembled context
    overflow_policy:  enum                  # fail | truncate_by_priority | split_work_unit

  # ---- CAPABILITIES + PERMISSIONS -------------------------------------
  capability_profile_ref: ProfileRef   # id + pinned version.  [A1]
                                       # Inline `capabilities`, `capability_denies`,
                                       # and `permissions` blocks REMOVED — they are
                                       # now one separately governed object with
                                       # `composition: intersect_only`. See §6–7.

  # ---- BUDGET ---------------------------------------------------------
  budget:
    per_attempt:
      input_tokens:   int
      output_tokens:  int
      tool_calls:     int
      wall_clock_s:   int
      cost_ceiling:   Money
    per_work_unit:
      max_attempts:   int
      total_cost_ceiling: Money
      files_touched:  int?            # null where not meaningful
    exhaustion_policy: enum           # fail_closed  (only permitted value at MVP)

  # ---- ACCEPTANCE -----------------------------------------------------
  acceptance:
    gate_profile_ref: GateProfileRef   # id + pinned version.  [A2]
                                       # Inline `mandatory_gates` REMOVED — now a
                                       # separately governed object with
                                       # `composition: union`. See §9.
    evidence_required: EvidenceType[] # what must exist for a result to be "verified"
    self_report_accepted: bool        # MUST be false for every Role
    artifact_schema:  SchemaRef       # the produced artifact is validated against this

  # ---- FAILURE POLICY -------------------------------------------------
  on_failure:                         # INLINE, deliberately.  [A4]
                                      # Extraction as `FailurePolicy` was considered
                                      # and REJECTED: no composition operator, and
                                      # high semantic coupling to the Role.
                                      # failure taxonomy -> action
    spec_ambiguous:       enum        # escalate_human | replan
    verification_failed:  enum        # retry_with_evidence | replan | escalate_human
    tool_error:           enum        # retry_backoff | escalate_human
    budget_exceeded:      enum        # escalate_human  (only permitted value)
    constraint_violated:  enum        # replan | escalate_human
    no_progress:          enum        # escalate_human  (only permitted value)
  escalation_target:  enum            # human  (only permitted value at MVP)

  # ---- QUALITY CONTROL ------------------------------------------------
  prompt_ref:         PromptRef       # id + pinned version. NEVER inline text.
  eval_suite:         EvalSuiteRef    # regression suite that must pass to publish
  change_policy:
    requires_eval_pass: bool          # true
    requires_human_approval: bool     # true
```

---

## 3. Field-by-field rationale

Every field below earns its place by naming a specific failure it prevents. If a field cannot name one, it does not belong (see §16).

### Identity

| Field | Why it exists | What breaks without it |
|---|---|---|
| `id` | Stable reference across versions | Renaming a Role orphans every historical WorkUnit |
| `version` | Pinning + replay | You cannot reproduce why a six-week-old task behaved as it did |
| `mandate` | One-sentence scope statement | Roles silently expand in scope until they overlap and duplicate |
| `status` | Lifecycle control | Draft Roles get dispatched real work |
| `supersedes` | Migration lineage | No way to audit how a Role's behaviour evolved |
| `owner` | Human accountability for the definition | Nobody owns the prompt that produced a bad outcome |
| `published_at` | Immutability marker | Roles get edited in place and history becomes fiction |

### Contract

| Field | Why it exists | What breaks without it |
|---|---|---|
| `consumes` | Declares valid inputs | The kernel cannot type-check a task DAG before executing it |
| `produces` | **Exactly one** artifact type | A Role that emits "whatever seems useful" cannot be gated, because gates are per-artifact-type |
| `emits_plan` | Separates planning capability from execution capability | Any Role could spawn work, and the DAG becomes unbounded |

`produces` being singular is a deliberate constraint. It forces decomposition to happen in the plan rather than inside an opaque model call, and it makes every output verifiable against a known schema.

### Quality control

| Field | Why it exists | What breaks without it |
|---|---|---|
| `prompt_ref` | Prompts are versioned assets, not string literals | Prompt edits become untracked production changes with no diff and no rollback |
| `eval_suite` | Regression testing for prompt/model changes | You upgrade a model and silently degrade three Roles with no signal |
| `change_policy` | Human gate on Role mutation | The system edits its own governance — the one autonomy that is unambiguously wrong |

The `eval_suite` field is the least glamorous and among the most important. A Role definition is production configuration that determines system behaviour. Changing it without a regression suite is deploying untested code. **Its contract is specified in Design Note 09.**

### The three extracted references  [A1, A2]

`capability_profile_ref`, `gate_profile_ref`, and `context_recipe_ref` are references rather than inline blocks. The extraction criterion is **not object size** — it is whether the sub-object needs a **composition operator**, because an embedded field in an immutable record cannot be combined with configuration from another layer.

| Reference | Operator | Composed with | Why extracted |
|---|---|---|---|
| `capability_profile_ref` | **intersect** (narrowing only) | Instance policy, WorkUnit request | Separate security governance; real reuse; "which Roles can write to the repo?" must be answerable from a few small profiles |
| `gate_profile_ref` | **union** (adding only) | Instance policy, WorkUnitClass, WorkUnit | Lets an instance add a mandatory gate without editing any Role |
| `context_recipe_ref` | none | — | Extracted for **lifecycle**: highest-churn component, and independently testable as a pure function |
| `eval_suite` | none | — | Lifecycle: changes when failure modes are learned, not when the prompt changes |
| `on_failure` | **none — not extracted** | — | Six enums, no operator, high coupling. Extraction rejected [A4] |

The flattened, composed result of all three is frozen into the **`ResolvedExecutionSpec`** at dispatch — the fully resolved bundle with every `intersect`/`union`/`min` already applied and hashed, specified in Note 02 §7 [A8]. Replay reads one hash rather than chasing six version histories. **Decompose the authoring model; flatten the execution model.**

---

## 4. Configuration vs runtime state

The single most important boundary in this document.

**Role is 100% configuration. It holds no runtime state whatsoever.**

| Configuration — on `Role` or a referenced object | Runtime state — on `WorkUnit` / `Attempt` / `Artifact` |
|---|---|
| Model tier (candidates resolved via the binding table) | Which model actually served this attempt, per call |
| `context_recipe_ref` | The resolved `ContextManifest` and its hash |
| `capability_profile_ref` — capability maxima | The scoped capability token minted for this attempt |
| `capability_profile_ref` — permission boundaries | Which permission checks were exercised or denied |
| Budget ceilings | Tokens consumed, cost incurred, calls made |
| `gate_profile_ref` — mandatory gates | Gate results and evidence produced |
| Failure policy (inline) | Attempt number, failure classification, escalation record |
| `prompt_ref` | The exact rendered prompt text for this attempt |

### Things that feel like they belong on `Role` but are runtime

These are the tempting mistakes. Each is listed with where it actually belongs.

| Tempting field | Where it belongs | Why |
|---|---|---|
| `current_task` | `WorkUnit.assigned_role_ref` | A Role is not an actor; it has no "current" anything |
| `memory` | Memory stores, retrieved by recipe | Per-Role memory is a private mutable channel that bypasses the compiler and cannot be audited |
| `success_rate` | Metrics projection over the event log | Derived data. If it lives on config it will drift, and worse, it invites the system to self-modify based on it |
| `cost_to_date` | Accounting projection | Same |
| `queue` / `inbox` | Kernel scheduler | Roles do not receive work; the kernel dispatches WorkUnits that reference them |
| `last_run_at` | Event log | Derived |
| `learned_heuristics` | Human-gated heuristic store | Nothing writes to Role config at runtime. Nothing. |

**Invariant:** once `published_at` is set, a Role version is byte-immutable. Any change produces a new version. Nothing in the runtime path may write to a Role.

### One named exception to the dichotomy: Memory  [D6]

The configuration/runtime split above has exactly **one** exception, and it is named concretely rather than generalised: a **`MemoryRecord`** (Design Note 05) is neither.

| Property | `MemoryRecord` |
|---|---|
| Human-approved | Yes — but it is not configuration; it governs nothing |
| Durable and versioned | Yes — but it is not runtime state; no execution produces it |
| Immutable, content-addressable, non-deletable | Yes |
| Instance-scoped | Yes |
| Readable by | **The Context Compiler only** |

A general third category ("approved durable context") was considered and **rejected as speculative generality** — it would have exactly one member. Collapsing `MemoryRecord` into `Artifact` was also rejected: "Artifact" means *output of work* consistently across Notes 02–03, and `expired` has no artifact analogue. If a second member ever appears, generalise then, with two examples to generalise from.

---

## 5. Model configuration

```yaml
# ON THE ROLE — semantics only  [A3]
model:
  tier:             frontier | standard | fast
  pinning:          pinned | floating_within_tier
  reasoning_effort: low | medium | high | max
  sampling_class:   deterministic | balanced | exploratory
  max_output_tokens: int

# ABOVE THE ROLE — the binding, owned operationally
ModelTierBinding:
  version:    SemVer
  bindings:
    - tier:       frontier
      candidates: [ModelRef]   # ordered; explicit versions, never aliases
```

### The split is by *who owns the decision*, not by field category  [A3]

- **The Role owns semantics** — `tier`, `reasoning_effort`, `sampling_class`, `max_output_tokens`. Only the Role author knows what the work needs.
- **The binding table owns implementation** — which concrete models serve a tier today. This changes when a model ships, a provider degrades, or cost pressure arrives.

Extracting a per-Role `ModelPolicy` was considered and **rejected**: it would leave you editing thirty objects on a model migration, which is the exact problem `tier` exists to solve.

**Deferred (C4):** the binding table as a *fleet-level* object, narrowable per instance, is deferred to instance #2. At MVP a single instance-level table serves. **Required now:** nothing reads the table from the instance object directly — it is read through a **resolver seam** that today returns instance values and later returns fleet ∩ instance. That seam is the entire cost of keeping the option open.

**A tier re-binding triggers evaluation of every Role bound to that tier** (Note 09 §7). Without that fan-out, `eval_suite` does not do the job it was introduced for.

**Why `candidates` is an ordered list with explicit versions.** Provider outages are real, and a Role that cannot run because one endpoint is degraded stalls the DAG. Explicit versions rather than floating aliases because "latest" silently changes system behaviour with no diff, no eval run, and no rollback path.

**Why `pinning`.** Verification-class Roles should be `pinned` — you want a stable judge. Implementation-class Roles can be `floating_within_tier` if you accept model churn in exchange for improvements. This is a per-Role risk decision and it should be explicit.

**Why `sampling_class` rather than a raw temperature.** Temperature is a provider-specific knob whose semantics vary. The Role should declare the *behaviour it needs* — a verifier needs `deterministic`, an architect exploring alternatives may want `exploratory` — and let the model adapter translate. This also keeps Role definitions portable across providers.

**Model diversity is a verification tool.** Where the verification Role uses a different model family than the implementation Role, their errors decorrelate. Same-family review produces correlated blind spots. This is expressible here and should be used deliberately.

---

## 6. Tool and capability configuration

A **capability** is not a tool. It is a tool *plus the scope in which that tool may act*.

**[A5] §6 and §7 together specify the `CapabilityProfile` object**, referenced from `Role.capability_profile_ref`. Capabilities and permissions are one object, not two: they answer the same question — blast radius — and separating them would force a reviewer to hold two documents in their head to answer one question.

```yaml
CapabilityProfile:
  id, version, owner, description
  composition:  intersect_only        # ★ may only NARROW. No widening syntax exists.

  capabilities:
    - tool:       "fs.read"
      scope:      "workspace://**"
      mode:       read
    - tool:       "shell.exec"
      scope:      "workspace://"      # cwd confinement
      mode:       execute
      rate_limit: { calls: 40, window_s: 600 }
  capability_denies: ["net.fetch", "db.write"]

  permissions:                        # the six dimensions of §7
    filesystem, repository, network, secrets, data, external_effects
```

**Composition:** `effective = RoleProfile ∩ InstancePolicy ∩ WorkUnit.requested`. Every tool referenced must be a registered, signed `Tool` (Note 03 §8, amendment E4); `effects: external` tools cannot be granted while `external_effects` is false.

### Rules

1. **Deny-by-default.** A tool absent from `capabilities` is unavailable. There is no ambient tool access.
2. **Role declares the maximum.** The kernel mints a per-WorkUnit capability token that is the *intersection* of the Role's maximum, the WorkUnit's declared need, and the instance policy. It may narrow. It may never widen.
3. **Denies always win.** `capability_denies` overrides any grant from any source. This exists so instance policy can carve out a hard prohibition without rewriting Role definitions.
4. **Enforcement lives at the tool broker, in code.** The prompt may *describe* the constraints for the model's benefit, but the prompt is never the control. A prompt is a suggestion; a broker is a boundary.
5. **Scope is expressed against logical roots**, never absolute host paths. `workspace://`, `repo://`, `artifact://`. This is what makes an instance sandbox actually enforceable and portable.

### Why the maximum/actual split matters

"Database Engineer has DB write access" is too coarse — it grants prod-write on a task that only needed to read a schema. The Role sets the ceiling; the WorkUnit's actual grant is minted narrow and expires. Least privilege must be per-task, not per-role.

---

## 7. Permission boundaries

Capabilities answer *which tools*. Permissions answer *what blast radius*. They are separate because the same tool can be safe or catastrophic depending on where it points.

Six dimensions, all deny-by-default:

| Dimension | What it bounds | MVP default |
|---|---|---|
| `filesystem` | Read/write globs, workspace type | read: repo; write: ephemeral worktree only |
| `repository` | Git read / worktree write / commit / push | `may_push: false` for every Role |
| `network` | Egress: none, allowlist, or open | `none` for implementation and verification |
| `secrets` | Named scopes only — never literal values | empty |
| `data` | DB access level, row scope | `none`; `row_scope: instance_only` always |
| `external_effects` | Send, deploy, spend | all `false` for every Role |

### Non-negotiables

- **`row_scope: instance_only` is the only permitted value.** Cross-instance data access is not a permission that can be granted. It is a boundary enforced below the Role layer, and no Role definition may express an intent to cross it.
- **`external_effects` are all false at MVP.** Anything outward-facing or irreversible goes through the human gate, not a Role permission. If a Role could set `may_send: true`, a prompt injection in a repo file becomes an outbound message.
- **`network.egress: none` for implementation and verification Roles.** This is the strongest available mitigation against untrusted content in the repository steering a credentialed loop. An agent that reads adversarial text and cannot reach the network can do far less damage.

### The threat this section is really about

Every file the system reads — source, issues, dependency READMEs, fetched pages — is potentially adversarial input. The permission layer is the assumption that the model *will* eventually be steered by something it read, and that the damage must be bounded by mechanisms the model cannot talk its way past.

---

## 8. Budget limits

Three scopes, each catching a different failure:

```yaml
budget:
  per_attempt:      { input_tokens, output_tokens, tool_calls, wall_clock_s, cost_ceiling }
  per_work_unit:    { max_attempts, total_cost_ceiling, files_touched }
  exhaustion_policy: fail_closed
```

| Scope | Failure it catches |
|---|---|
| `per_attempt` | A single runaway call — tool-call loops, unbounded generation, a hung command |
| `per_work_unit` | Retry storms: three attempts each within budget that together burn 40× the value of the task |
| `files_touched` | Scope explosion — a "fix a typo" unit that rewrites nineteen files |

`files_touched` deserves emphasis. It is a *scope* control disguised as a budget, and it is one of the cheapest, highest-signal detectors of a misunderstood task. A unit that blows it is almost never a unit that just needed more room; it is a unit whose spec was wrong.

**`fail_closed` is the only permitted exhaustion policy.** A budget that auto-extends is not a budget. Exhaustion escalates to a human, who may explicitly re-authorise with a new ceiling. That re-authorisation is a logged human decision, not an automatic one.

**Budgets belong per-Role, not global.** An architecture unit and a lint-fix unit have legitimately different cost profiles by an order of magnitude, and a single global ceiling is either too tight for one or useless for the other.

---

## 9. Acceptance and verification configuration

**[A6] This section specifies the `GateProfile` object**, referenced from `Role.acceptance.gate_profile_ref`.

```yaml
GateProfile:
  id, version, owner, description
  composition: union_only             # ★ may only ADD. No removal syntax exists.
  bindings:
    - { gate_ref: "artifact.schema_valid@1.0.0", blocking: true, order: 10 }
    - { gate_ref: "build.compiles@2.0.0",        blocking: true, order: 20 }
    - { gate_ref: "types.check@1.4.0",           blocking: true, order: 30 }
    - { gate_ref: "tests.affected_pass@4.0.0",   blocking: true, order: 40 }
    - { gate_ref: "constraints.respected@1.0.0", blocking: true, order: 50 }
    - { gate_ref: "review.independent@1.1.0",    blocking: true, order: 60 }

# remains inline on Role.acceptance:
  evidence_required: [gate_results, diff, test_output, context_manifest_hash]
  self_report_accepted: false
  artifact_schema: "schema://diff/1.0.0"
```

### Verdicts are four-valued, not boolean  [A10]

`pass` · `fail` · `indeterminate` · `error` (Note 03 §4).

| Verdict | Consumes an attempt? | Action |
|---|---|---|
| `pass` | — | Proceed |
| `fail` | **Yes** | `FailureRecord`; apply `on_failure` |
| `indeterminate` | **No** | Escalate. Never retry blindly |
| `error` | **No** — gate infrastructure fault | Retry the *gate*; never a `FailureRecord` |

`blocking` is orthogonal to the verdict: a blocking gate halts on `fail` or `indeterminate`; an advisory gate records and proceeds. **Neither may proceed past `error`** — an unrun gate is not an advisory pass.

### Segment visibility applies to gates  [A11]

Every gate in a profile must respect artifact segment visibility (Note 02 §5), and **gate evidence inherits the maximum visibility of anything it quotes** (Note 03 §5). A gate may read `private` segments only if it is `audit_only`, in which case all its evidence is forced `private` and it may decide no criterion that feeds a retry. Without this, a `GateResult` would launder private content into a `FailureRecord` and thence into a retry.

### Design rules

1. **Gate ordering is by cost, ascending.** Deterministic, cheap, uncorrelated-with-the-generator gates run first. Never spend a model call reviewing something that does not compile. On a blocking `fail`, finish the current stage and every cheaper one — then short-circuit the expensive ones (Note 03 §10).
2. **Union semantics, monotonically strengthening.** `effective = RoleProfile ∪ InstancePolicy ∪ WorkUnitClass ∪ WorkUnit`. No layer may remove a binding contributed by another. On conflict: `blocking` beats advisory, stricter threshold wins, higher version wins. This makes composition **order-independent**, and means adding a layer can only make verification stricter, never weaker.
3. **`self_report_accepted: false`, always.** An agent's claim that it finished is an input to the process, never an output of it. "Verified" means a gate ran and produced evidence. This field exists in the schema not because it might be true, but so that any attempt to set it true is a visible, reviewable configuration change rather than an implicit assumption.
4. **Evidence is mandatory and is itself an artifact.** A gate that passes without emitting evidence is indistinguishable from a gate that did not run.
5. **`constraints.respected` is the gate that makes architecture verifiable.** It checks a diff against the `constraints[]` array of the governing `ArchitectureDecision`. This is what converts design from unverifiable prose into a partially checkable contract.

### Blocking vs advisory

`blocking: true` halts the unit. `blocking: false` records a finding and proceeds. Advisory gates exist for signals that are useful but too noisy to stop work on — style suggestions, complexity metrics, coverage deltas below a threshold. Keeping them in the same ordered list means they are visible in the same evidence record rather than living in a separate, ignored channel.

---

## 10. Supervisor and delegation relationships

**Decision: the `Role` schema contains no supervisor field, no subordinates field, and no delegation-target field. None.**

This is the field most likely to be requested and it must not be added. Here is the full reasoning and the mechanism that replaces it.

### Why not

If a Role can name the Roles it delegates to, three things follow immediately:

1. **The kernel is no longer the scheduler.** Dispatch decisions become distributed across Role configs, and there is no single place that knows the shape of the work. Debugging a stuck DAG means reading every Role definition.
2. **The org chart returns in the type system.** `architect.delegates_to: [senior_swe]` and `senior_swe.delegates_to: [swe]` *is* a reporting line. The hierarchy re-enters through the schema even though we removed it from the metaphor.
3. **Cycles become expressible.** A → B → A is trivially constructible in config, and now loop detection is a graph problem over configuration rather than a property of a plan the kernel validated before executing.

### What replaces it

Delegation is not a relationship between Roles. It is an **artifact that the kernel validates and executes**.

```
Role with emits_plan: true
        │
        │ produces
        ▼
   TaskPlan artifact
        │  nodes: [{ objective, role_ref, acceptance_criteria, depends_on[] }]
        │
        │ submitted to
        ▼
   KERNEL — validates the plan before any of it runs:
        · every role_ref exists, is active, and is permitted by instance policy
        · the graph is a DAG (no cycles)
        · every node's acceptance_criteria are non-empty and checkable
        · consumes/produces types line up across every edge
        · aggregate budget is within the parent unit's ceiling
        │
        ▼
   Dispatch (kernel owns scheduling, ordering, concurrency, retries)
```

**Which Roles may appear in a plan is instance policy, not Role config.** It lives in the instance's policy document — one place, auditable, changeable without touching any Role definition. This is the field that would otherwise have been `delegates_to`, relocated to where it can be governed.

### The resulting shape

There is no hierarchy. There is a **DAG of work** and a **flat set of Roles**. The architect does not manage the implementer. The architect *produces a decision artifact that the implementer's WorkUnit consumes*, and the kernel sequences them. That is a data dependency, not a reporting line — and unlike a reporting line, it is typed, validated, and visible in a single graph.

---

## 11. Versioning

### Rules

1. **Semver on `Role`, `ContextRecipe`, `Prompt`, `Schema`, `Gate`.** Every configuration object is independently versioned.
2. **Published versions are immutable.** Editing a published Role is not possible. You publish a new version. `status: draft` is the only editable state.
3. **WorkUnits pin exact versions** at dispatch time, for every referenced object. Recorded in the WorkUnit, never resolved dynamically at execution.
4. **Semver semantics for a Role:**
   - **Patch** — prompt wording, description, non-behavioural clarification.
   - **Minor** — additive: a new gate, a wider budget, an added capability, a new recipe layer.
   - **Major** — anything that breaks a contract: `produces` changes, `consumes` narrows, a mandatory gate is removed, permissions are widened.
5. **Publishing requires `eval_suite` to pass and a human to approve.** Both, without exception. Role config is production behaviour.
6. **Deprecation is a two-phase flow.** `active → deprecated` (existing WorkUnits finish, no new dispatch) `→ retired` (references are historical only). Versions are never deleted, because deleting one makes every historical trace that pinned it unreplayable.

### Why this much ceremony

The alternative — mutable Roles — means that when you investigate a failure from three weeks ago, the configuration that produced it no longer exists. Replayability is the property we chose *instead* of determinism, and immutable versioned config is the entire foundation of it. Give that up and the audit log degrades to a story about what might have happened.

---

## 12. The `ContextRecipe` schema

A recipe is a **declarative retrieval program**: what to fetch, from where, how much of the budget it may consume, and what must never be included.

```yaml
ContextRecipe:
  id:               RecipeId
  version:          SemVer
  description:      string
  total_budget_tokens: int

  layers:
    - name:         string
      source:       SourceId        # which store/provider serves this layer
      selector:     SelectorExpr    # what to pull from it
      priority:     int             # truncation order; 1 = never truncated
      max_tokens:   int
      required:     bool            # missing => compilation fails
      freshness:    Duration?       # max staleness; stale => refetch or fail
      on_miss:      enum            # fail | omit | substitute
      transform:    TransformId?    # e.g. signatures_only, summarize, redact

  exclusions:
    - pattern:      ExclusionExpr
      reason:       string          # MANDATORY — every exclusion states its harm
      enforcement:  enum            # hard_filter | assert_absent

  assembly:
    order:          [layer_name]    # deterministic ordering
    overflow_policy: enum           # fail | truncate_by_priority | split_work_unit
    dedupe:         bool
    emit_manifest:  bool            # always true
```

### Why exclusions are first-class, with mandatory reasons

Most context systems only describe what to *include*. The interesting design work is in what to leave out, and an exclusion without a stated reason gets deleted by the next person who thinks it looks arbitrary. Requiring `reason` makes each exclusion a defended decision rather than an accident.

`enforcement: assert_absent` is stronger than filtering — it fails compilation if the excluded content appears via any layer. Use it where the exclusion is load-bearing for correctness rather than merely for budget. Independence of review is the canonical case.

### Exclusions are defence in depth, not the primary mechanism  [A7]

**The primary independence mechanism is artifact segment visibility** (Note 02 §5): `private` segments — reasoning traces, self-assessments — are declared unaddressable by the *artifact schema*, so no recipe selector can name them and no predicate can reach them (Note 08 §3).

Recipe exclusions remain, demoted to a second layer. The distinction matters because they are different *kinds* of defence:

| | Segment visibility | Recipe exclusion |
|---|---|---|
| Direction | **Additive** — nothing can reach it | **Subtractive** — must anticipate every leak path |
| Failure mode | Sound | Silent, if a path was missed |
| Default for a new recipe author | Safe | Unsafe — forgetting is the failure |

Keep both. Every `assert_absent` below is now a backstop against a schema misdeclaration rather than the load-bearing control.

---

## 13. The three initial recipes

### 13.1 `architecture.v1`

**Serves:** the Architect Role. **Budget:** 60k tokens.

**Retrieves:**

| Layer | Selector | Transform | Priority | Max |
|---|---|---|---|---|
| `objective` | The WorkUnit's objective + acceptance criteria | — | 1 | 2k |
| `inherited_constraints` | `constraints[]` from any parent ArchitectureDecision | — | 1 | 2k |
| `system_map` | Module/directory tree, module boundary manifest, dependency graph | `structure_only` | 2 | 8k |
| `public_interfaces` | Exported signatures, types, and doc comments for affected + adjacent modules | `signatures_only` | 2 | 14k |
| `interface_contracts` | API schemas, DB DDL, event/message schemas, config surface | — | 2 | 12k |
| `decision_log` | ADRs tagged to affected subsystems, `still_valid = true` only, max 12, recency-weighted | — | 3 | 12k |
| `nonfunctional` | SLOs, security policy, compliance constraints for this instance | — | 3 | 5k |
| `dependency_inventory` | Declared dependencies with versions and license constraints | — | 4 | 3k |
| `open_incidents` | Unresolved incidents touching affected subsystems | `summary` | 5 | 2k |
| `memory` | Active `MemoryRecord`s matching this unit's scope | `memory_render` | **5** | **3k** |

**Deliberately excludes:**

| Excluded | Reason |
|---|---|
| Function bodies / full file contents | Forces reasoning from interfaces and constraints. Given implementation detail, the model pattern-matches to local code and produces "change line 47" instead of a decision. It also consumes the budget that interface breadth needs. |
| Diffs and commit history | Architecture answers "what should be true," not "what changed recently." Recency bias toward whatever was last touched is a real and observed failure. |
| Test output and runtime logs | Verification evidence, not design input. Present, it drags the unit into debugging. |
| Any other Role's reasoning trace | Reasoning traces are persuasive and unverified. Inheriting them means inheriting their errors with added confidence. |
| Deprecated or superseded ADRs | Contradictory guidance produces confidently wrong syntheses of incompatible decisions. |
| Unapproved learned heuristics | A never-human-reviewed inference must not shape a decision that constrains every downstream unit. |
| Unrelated subsystems | Budget, and invented cross-cutting coupling that nobody asked for. |

**`assert_absent`:** other Roles' reasoning traces.

---

### 13.2 `implementation.v1`

**Serves:** the Implementer Role. **Budget:** 100k tokens.

**Retrieves:**

| Layer | Selector | Transform | Priority | Max |
|---|---|---|---|---|
| `objective` | Objective + acceptance criteria for this unit only | — | 1 | 2k |
| `governing_decision` | `decision` + `constraints[]` + `affected_paths[]` from the ArchitectureDecision | `decision_and_constraints_only` | 1 | 3k |
| `target_files` | Full contents of `affected_paths` | — | 1 | 30k |
| `neighbourhood` | Direct callers and callees of target symbols | `signatures_plus_relevant_bodies` | 2 | 20k |
| `existing_tests` | Test files covering the affected paths | — | 2 | 15k |
| `conventions` | Lint config, formatter config, project style guide, framework idioms | — | 2 | 8k |
| `interface_contracts` | Public API and DB schemas that must not break | — | 2 | 8k |
| `prior_attempt_evidence` | Structured failure record from previous attempts on **this unit** | `structured_only` | 1 | 6k |
| `runtime_surface` | Build/test/run commands, environment description | — | 3 | 3k |
| `memory` | Active `MemoryRecord`s matching this unit's scope | `memory_render` | **5** | **3k** |

**Deliberately excludes:**

| Excluded | Reason |
|---|---|
| Architecture `rationale` and `alternatives_rejected` | Invites re-litigation of a settled decision. The implementer's job is to satisfy `constraints[]`, not to agree with them. If a constraint is genuinely impossible, the correct output is a `constraint_violated` escalation, not a quiet redesign. |
| Prior attempts' *reasoning* (as opposed to their structured failure evidence) | Repeats the failed approach with more conviction. The structured record — which gate, which assertion, what stderr — is the useful signal; the narrative is anchoring. |
| Other in-flight WorkUnits' diffs | Creates hidden coupling between units the DAG says are independent, and produces merge conflicts the kernel cannot reason about. |
| Full decision-log history | Only the governing decision binds this unit. Everything else is budget spent on scope creep. |
| Product, business, and market context | Not decision-relevant at this altitude. Its main effect is unrequested scope expansion. |
| Unapproved learned heuristics | Same as above. Only **committed, active** `MemoryRecord`s reach the `memory` layer. |
| Files outside `affected_paths` + neighbourhood | The `files_touched` budget is enforcement; this exclusion is prevention. |

### The `memory` layer  [D2]

Added to `architecture.v1` and `implementation.v1`. **Not** to `verification.v1` — a verifier judging a diff against a spec must not be influenced by advisory belief.

```yaml
- name:       memory
  source:     memory_store            # the exclusive SourceId; see Note 05 §7
  selector:   scope_match(work_unit) AND status == active
  priority:   5                       # LOW — never 1
  max_tokens: 3000
  required:   false
  on_miss:    omit
  transform:  memory_render
```

Three constraints, each derived rather than chosen:

1. **Priority is never 1.** §14 states priority 1 is never truncated, so **memory is always the first layer truncated.** Advisory content may never displace the objective, the governing decision, or the target files.
2. **`required: false`, `on_miss: omit`.** An instance with empty Memory must compile context successfully; a required memory layer would make a new instance unable to run at all.
3. **Hard token cap.** Memory is the layer that grows without bound as an instance ages.

Records are marked `verified` or `unverified` by the `asserted_against` check (Note 05 §8), and conflicting memory is **dropped and flagged, never merged**. Precedence within the assembled context: repository → pinned artifacts → policy-derived facts → memory.

---

### 13.3 `verification.v1`

**Serves:** the Verifier Role. **Budget:** 80k tokens.
**This recipe's exclusions are the most load-bearing in the system.** Verification value comes entirely from independence, and independence is destroyed by context, not by prompt instructions.

**Retrieves:**

| Layer | Selector | Transform | Priority | Max |
|---|---|---|---|---|
| `spec` | Original objective + acceptance criteria, **as authored, not as restated by the implementer** | — | 1 | 3k |
| `binding_constraints` | `constraints[]` from the governing ArchitectureDecision | `constraints_only` | 1 | 2k |
| `diff` | The complete change, unabridged | — | 1 | 25k |
| `pre_post_state` | Affected files before and after | — | 2 | 20k |
| `gate_evidence` | Results from every deterministic gate: build, types, lint, tests, coverage delta | — | 1 | 10k |
| `runtime_evidence` | What actually executed — smoke results, logs, observed behaviour | — | 2 | 8k |
| `invariants` | Interface contracts and security policy applicable to affected paths | — | 2 | 6k |
| `test_provenance` | Which tests pre-existed vs which this diff added, explicitly flagged | — | 1 | 4k |

**Deliberately excludes:**

| Excluded | Reason |
|---|---|
| **The implementer's reasoning trace** | The single most contaminating input available. A verifier that reads a plausible rationale evaluates the rationale rather than the code, and the rationale is optimised for plausibility. `assert_absent`. |
| **The implementer's self-summary, commit narrative, or PR description** | Same mechanism, more subtle. It reframes the diff before the verifier ever reads it. The verifier reads the spec and the code, and nothing that stands between them. `assert_absent`. |
| **Any self-reported confidence or "done" claim** | Model confidence is poorly calibrated and reads as evidence. `assert_absent`. |
| **Prior verifiers' verdicts on this same diff** | Anchoring. A second opinion that has seen the first opinion is not a second opinion. `assert_absent`. |
| Architecture `rationale` prose | The verifier checks against `constraints[]`, which are checkable. Rationale is not, and it dilutes the check. |
| Write-capable tools of any kind | Not a context exclusion but a capability one, and it is what makes this Role structurally independent: it cannot "fix it while it's here," so every finding must surface through the gate as evidence. |

**On `test_provenance`.** Implementer-authored tests are evidence to be scrutinised, not authority to defer to. A test written by the same process that wrote the bug can encode the bug as expected behaviour. Flagging provenance lets the verifier weight them correctly; hiding them entirely would be worse, since the tests themselves are part of the change under review.

---

## 14. How the Context Compiler builds a context

Deterministic pipeline. No model call anywhere in it.

```
INPUT: WorkUnit (pins role@version, which pins recipe@version)

 1. RESOLVE      Load Role@version, Recipe@version, Prompt@version.
                 All pinned. No dynamic resolution.

 2. GATHER       For each layer, query its source with its selector.
                 Enforce `freshness`. Apply `on_miss`.
                 Missing + required => COMPILATION FAILS. Never silently degrade.

 3. TRANSFORM    Apply per-layer transforms (signatures_only, summarize, redact).
                 Transforms are deterministic and versioned.

 4. FILTER       Apply exclusions.
                 hard_filter  => remove matching content
                 assert_absent => if present anywhere, ABORT compilation
                 This runs AFTER gather, so an exclusion cannot be defeated
                 by content arriving through an unexpected layer.

 5. DEDUPE       Same file pulled by two layers appears once, at highest priority.

 6. BUDGET       Sum tokens. If over `total_budget_tokens`, apply overflow_policy:
                   fail                 => escalate: the unit is too large
                   truncate_by_priority => drop from highest priority number down;
                                           priority 1 is NEVER truncated
                   split_work_unit      => escalate to kernel for decomposition
                 Every truncation is recorded in the manifest.

 7. ASSEMBLE     Order layers per `assembly.order`. Deterministic.

7a. RENDER      Apply the rendering contract (below). Mandatory.  [E2]

 8. MANIFEST     Emit ContextManifest:
                   { recipe_ref, layer_hashes[], source_versions[],
                     truncations[], total_tokens, assembled_hash, compiled_at }

OUTPUT: (rendered_context, ContextManifest)
```

### 14a. The rendering contract  [E2]

> **An unlabelled context is an unattributable context.**

The precedence order — repository, then pinned artifacts, then policy-derived facts, then memory — **is a fiction unless the rendering makes it visible.** Precedence that exists only inside the compiler does nothing at inference time: a model that cannot distinguish repository ground truth from an advisory memory record has no basis for weighting them differently, however carefully the compiler ordered them.

Every layer renders as a delimited block with a mandatory header. **No layer may be rendered without one, and no content may appear outside a labelled block.**

```
── <layer name> · <authority tier> · <provenance> [· <marks>] ──────────
<content>
[── truncated: <n> of <m> <units> omitted (<policy>) ──]
────────────────────────────────────────────────────────────────────────
```

| Header field | Content |
|---|---|
| layer name | The recipe layer that produced it |
| **authority tier** | `ground-truth` · `contract` · `policy` · `advisory` |
| provenance | Commit SHA, artifact id@version, policy version, or memory id@version |
| marks | `verified` / `unverified`, `truncated`, `human-asserted` |

| Tier | Sources |
|---|---|
| `ground-truth` | Live repository state |
| `contract` | Pinned input artifacts, objective, acceptance criteria, constraints |
| `policy` | Policy-derived facts and bindings |
| `advisory` | Memory |

**Silent truncation is prohibited.** Any layer trimmed at step 6 renders an explicit notice naming the count and the policy — never the content. A file cut at 200 lines that *looks* complete makes the model reason confidently about code that is not there, and conclude, correctly given what it sees, that a symbol does not exist. Among the most common and least visible context failures, and entirely preventable here.

**Rules.** Rendering is a pure function — the same manifest renders byte-identically, which is what makes replay mode 2's hash comparison meaningful. Ordering follows `assembly.order`, but **authority is carried by the label, not by position**, so a recipe may order layers for any reason without weakening attribution. Priority-1 layers are never truncated and so never carry a notice. `assembled_hash` is computed **over the rendered output**, not the layer set. A redaction assertion runs at rendering — the last point before content leaves the kernel's control.

### The manifest is the point

The `ContextManifest` is a first-class artifact attached to the attempt. It is what makes a failure investigable: given a bad output, you can determine exactly what the model saw, what it did not see, what was truncated away, and which version of which source served each layer. Without it, every failure investigation is speculation about the prompt.

It is also the unit of caching, the input to context-quality evaluation, and — because `assembled_hash` is stable — the mechanism by which "same inputs" can be verified even though "same outputs" cannot be guaranteed.

**Compilation is testable.** Given a fixed repository state and a fixed WorkUnit, compilation is a pure function. That means the context layer — the highest-leverage component in the system — has a real test suite, which is unusual and valuable.

---

## 15. Worked example: one Work Unit end to end

**Founder intent:** *"Password reset is being abused. Add rate limiting."*

### Stage A — Architecture

```yaml
WorkUnit:
  id:        wu_001
  objective: "Determine the approach for rate limiting the password-reset flow."
  role_ref:  architect@1.2.0
  acceptance_criteria:
    - "Names a specific mechanism and where it sits in the request path."
    - "Emits machine-checkable constraints for implementation."
    - "States what is explicitly out of scope."
  budget:    { cost_ceiling: $2.00, wall_clock_s: 300 }
```

Compiler runs `architecture.v1`: system map, public interfaces (signatures only), the existing rate-limit middleware contract, four relevant ADRs, security policy, dependency inventory. **No function bodies. No diffs. No prior reasoning.** Manifest emitted at 41,200 tokens, no truncation.

**Artifact produced:**

```yaml
ArchitectureDecision:
  id: ad_014
  problem:  "Password-reset endpoint has no abuse control; enumeration and mail-flood both viable."
  decision: "Apply the existing token-bucket middleware at the route layer,
             keyed on (email_hash, source_ip). Reuse the current Redis backing store."
  rationale: "..."                     # excluded from downstream recipes
  alternatives_rejected: ["..."]       # excluded from downstream recipes
  constraints:
    - id: c1  "No new runtime dependency."
    - id: c2  "Must reuse rateLimiter from src/middleware/rateLimit.ts. No new limiter."
    - id: c3  "No change to the public API contract of POST /auth/password-reset."
    - id: c4  "Response on limit must not reveal whether the account exists."
    - id: c5  "Limit values must be config-driven, not literals."
  affected_paths: ["src/routes/auth/passwordReset.ts", "src/config/limits.ts"]
  out_of_scope:   ["Global API rate limiting", "CAPTCHA", "account lockout"]
```

Gates: `artifact.schema_valid` ✓, `constraints.checkable` ✓ (each constraint is mechanically assertable). **Human approves the decision** — this is the human gate that matters most, since every downstream unit inherits these constraints.

### Stage B — Implementation

```yaml
WorkUnit:
  id:        wu_002
  objective: "Implement rate limiting on POST /auth/password-reset per ad_014."
  role_ref:  implementer@2.0.1
  consumes:  [ad_014]
  depends_on: [wu_001]
  acceptance_criteria:
    - "Constraints c1–c5 hold."
    - "Tests cover: under limit, at limit, over limit, and identical response shape for existing vs non-existent account."
    - "No change to the endpoint's public request/response schema."
  budget:    { cost_ceiling: $6.00, files_touched: 4, max_attempts: 3 }
```

Compiler runs `implementation.v1`: objective, `ad_014.decision` + `constraints[]` + `affected_paths[]` **only**, full bodies of the two target files, `rateLimit.ts` and its direct callers, the existing auth tests, lint/style config, the API schema, build/test commands. **The rationale and rejected alternatives are filtered out.** 68,400 tokens.

Executor runs in an ephemeral git worktree. Capabilities: `fs.read`/`fs.write` scoped to `workspace://`, `shell.exec` scoped to the worktree, `git.commit` — **no network egress, no push, no secrets**.

**Artifact:** `CodeDiff` — 3 files, +91/−4, plus evidence: build ✓, typecheck ✓, 7 new tests passing, lint ✓.

### Stage C — Verification

```yaml
WorkUnit:
  id:        wu_003
  objective: "Verify wu_002's diff against its spec and ad_014's constraints."
  role_ref:  verifier@1.1.0        # different model family than implementer@2.0.1
  consumes:  [diff_wu_002, ad_014, spec_wu_002]
  depends_on: [wu_002]
```

Compiler runs `verification.v1`: the spec **as originally authored**, `constraints[]` only, the complete diff, pre/post file state, all deterministic gate output, runtime evidence, the API contract, and test provenance flagging all 7 tests as implementer-authored.

**`assert_absent` blocks:** the implementer's reasoning trace, its commit message narrative, its self-summary, any confidence claim. The verifier sees the spec and the code, and nothing that stands between them. Capabilities: read + execute tests only — **no write capability of any kind**.

**Artifact:**

```yaml
VerificationReport:
  verdict: changes_requested
  constraint_checks:
    c1: pass    # no dependency delta
    c2: pass    # reuses existing limiter
    c3: pass    # schema unchanged
    c4: FAIL    # see finding f1
    c5: pass    # values read from config
  findings:
    - id: f1
      severity: blocking
      constraint: c4
      location: "src/routes/auth/passwordReset.ts:58"
      claim: "Limited responses differ by account existence."
      evidence: "Existing account -> 429 after 3 attempts. Unknown account -> 200 with
                 generic body, unlimited. Enumeration oracle is preserved, and the
                 rate limit is the signal. Reproduced: [test output]."
      suggested_direction: "Key the bucket before the account lookup, not after."
  test_assessment:
    - "7 implementer-authored tests pass but none asserts response equivalence
       across existing/non-existent accounts — the exact property c4 requires."
```

The verifier found a real security defect that every deterministic gate passed, and it found it because the constraint was written to be checkable and because it could not read the implementer's account of what it had built.

### Stage D — Loop and close

Kernel classifies `verification_failed` → `retry_with_evidence` (attempt 2 of 3). `wu_002` recompiles with `prior_attempt_evidence` containing the **structured finding only** — not the previous attempt's reasoning. Second diff keys the bucket pre-lookup and adds the equivalence test. Verifier returns `verdict: pass`. **Human approves the merge.** Event log retains every manifest hash, gate result, and artifact, so the entire chain is replayable.

**Note what carried the weight:** not four layers of hierarchy. A checkable constraint (`c4`), an information boundary (verifier blind to the implementer's narrative), and a capability boundary (verifier cannot patch what it finds).

---

## 16. What must NOT be in the `Role` schema

Each entry names where the field belongs instead, and the specific failure it causes if placed on `Role`.

### Hierarchy and identity

| Field | Belongs | Failure if included |
|---|---|---|
| `reports_to` / `manages` / `subordinates` | Nowhere | Re-introduces the org chart in the type system. The DAG expresses dependency; nothing else should. |
| `delegates_to` | Instance policy | Distributes scheduling across configs; kernel loses control of the graph; cycles become expressible. |
| `seniority` / `level` / `title_rank` | Nowhere | Encodes a human-org concept with no mechanical meaning. Implies unenforced authority. |
| `persona` / `tone` / `personality` | Nowhere | Fails the legitimacy test: differs in no enforced dimension. Persona diversity does not decorrelate errors — only different evidence does. |

### Runtime state

| Field | Belongs | Failure if included |
|---|---|---|
| `current_task` / `queue` / `inbox` | Kernel scheduler | Turns config into a mutable actor. Concurrency becomes unsafe. |
| `memory` | Memory stores, via recipe | A private channel that bypasses the Context Compiler — unauditable, unbudgeted, and invisible in the manifest. |
| `success_rate` / `cost_to_date` / `last_run_at` | Metrics projection | Derived data drifting in config. Worse: invites the system to self-modify based on its own scorecard. |
| `retry_count` | `Attempt` | Retries are per-unit, not per-role. Shared counters mean one unit's failures throttle an unrelated one. |

### Learning and mutation

| Field | Belongs | Failure if included |
|---|---|---|
| `learned_heuristics` | Human-gated heuristic store | Nothing writes to Role config at runtime. A wrong inference promoted to config poisons every future unit, silently, for weeks. |
| `auto_tuning` / `self_improvement` | Nowhere at MVP | The system editing its own governance is the one autonomy that is unambiguously wrong. |

### Configuration in the wrong place

| Field | Belongs | Failure if included |
|---|---|---|
| Inline prompt text | `prompt_ref` | Untracked production changes with no diff, no review, no rollback. |
| Hardcoded model version | The tier binding table, resolved from `model.tier` | Model migration becomes an edit to every Role. |
| Inline `capabilities` / `permissions` / `mandatory_gates` | `capability_profile_ref`, `gate_profile_ref` | An embedded field cannot be composed with instance policy. See §3. |
| `instance_id` / company identity | Instance-to-Role bindings | Roles are shared OS assets. Binding them to one company makes reuse impossible — which defeats the whole premise. |
| Literal secrets or credentials | Secret scopes | Obvious, and it will be attempted for convenience at some point. |
| `skills: []` as free-form strings | Nowhere | Fails the legitimacy test: unenforced, unverifiable, and read as capability when it is decoration. |
| Cost accounting / billing config | Instance policy | Different companies price the same Role differently. |

### The general rule

> If a field cannot name a specific failure it prevents, and that prevention is not mechanically enforced somewhere in the runtime, it does not belong in `Role`.

---

## 17. Deferred questions

Explicitly out of scope here, ordered by when they will bite:

1. ~~**`WorkUnit` and `Artifact` schemas**~~ — **RESOLVED**, Note 02.
2. **`SelectorExpr`** — **PARTIALLY RESOLVED.** The boolean predicate half is Note 08. `neighbourhood`'s static analysis and the `rank`/`limit` clauses of a retrieval selector remain **deferred** — ranking needs measured data (Note 05 §15, Note 08 §14).
3. ~~**The `constraints.respected` gate**~~ — **RESOLVED** [A9]. Criteria taxonomy C0–C3 (Note 02 §3) and the constraint form vocabulary with the demotion doctrine (Note 03 §12). The `c4` example was mis-classified: it is an `equivalence` constraint and compiles to a **C1** differential test, not C2.
4. ~~**Gate registry**~~ — **RESOLVED**, Note 03 §8, plus tool registration (E4).
5. ~~**Instance policy schema**~~ — **RESOLVED**, Note 04. `delegates_to` lives there as `admitted_roles`.
6. ~~**Memory store schemas — the four stores**~~ — **RESOLVED and CORRECTED** [D1]. There are **not** four stores. Notes 02–04 absorbed three of the four: ground truth is the **repository**, the decision log is **`ArchitectureDecision` artifacts**, and execution traces are **`Attempt` + the event log**. Memory retains five *kinds* — `knowledge`, `objective`, `heuristic`, `reference`, `preference` (Note 05 §2) — all human-approved, all advisory. Memory informs; it never constrains.
7. ~~**Eval suite format**~~ — **RESOLVED**, Note 09.
8. **Storage and event-log design** — deliberately last. The model should not be shaped by the database.

---

*End of Design Note 01.*

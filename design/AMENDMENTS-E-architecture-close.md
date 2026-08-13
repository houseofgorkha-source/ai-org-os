# AI-Org OS — Amendment Set E: Architecture-Pass Close

**Status:** **APPLIED** in the controlled pass of 2026-08-12. Notes 01-09 now reflect E1-E4.
**Purpose:** Hold the three closing amendments in full, ready to merge during the single controlled pass.
**Why a separate file:** E1 and E2 are pages of substantive content, not one-line ledger entries. The main ledger holds dispositions; this holds the text.

| # | Target | Content | MVP |
|---|---|---|---|
| E1 | Note 02 §4, §8, §9 | `TaskPlan` artifact schema and its validation rules | must-apply |
| E2 | Note 01 §14 | Context rendering contract | must-apply |
| E3 | Note 07 §18 | AIOS as a deferred implementation-substrate evaluation | must-apply (one line) |

---

## E1 — `TaskPlan` artifact schema

**Targets:** Note 02 §4 (artifact type), §8 (DAG semantics), §9 (validation).
**Rationale:** `TaskPlan` has been referenced since Note 02 and remained informal through four notes. Its *semantics* are fully specified — DAG rules (02 §8), no verification nodes (03 §1, B10), role admission (04 §8), class pipelines (04 §9). Only the field list is absent.

### E1.1 Artifact type

```yaml
Artifact:
  type: TaskPlan
  schema_ref: "schema://task_plan/1.0.0"
  segments:
    - name: plan              visibility: public
    - name: decomposition_rationale  visibility: restricted
    - name: reasoning_trace   visibility: private
```

Segment visibility follows Note 02 §5: a plan's *rationale* is restricted, and the planner's reasoning is unreachable — a human approving the plan judges the decomposition, not the planner's account of it.

### E1.2 Content

```yaml
TaskPlan:
  id:            PlanId
  version:       SemVer
  instance_id:   InstanceId
  intent_ref:    IntentId

  # ---- LINEAGE (Note 02 §8 rule 2 — plans are immutable) --------------
  supersedes:    PlanId@SemVer?
  superseded_by: PlanId@SemVer?
  replan_reason:
    triggered_by: FailureRecordId | EscalationId | HumanDecision
    summary:      string

  # ---- NODES ----------------------------------------------------------
  nodes:
    - node_id:            string
      objective:          string              # ONE imperative outcome
      role_ref:           RoleId@SemVer
      class:              WorkUnitClass       # Note 02 §17.1
      expected_output:    ArtifactType
      acceptance_criteria: [Criterion]        # typed, Note 02 §3
      constraints:                            # by reference, never restated
        - { source_node: string?, source_artifact: ArtifactId?,
            constraint_ids: [string] }
      affected_paths:     PathGlob[]
      budget:             BudgetRequest
      approvals_required: [ApprovalRequirement]

  # ---- EDGES (authored) ----------------------------------------------
  edges:
    - from: node_id
      to:   node_id
      kind: artifact | ordering               # `resource` is DERIVED — see below

  # ---- AGGREGATE ------------------------------------------------------
  budget_aggregate:  { execution: Money, verification: Money }
  status:            draft | approved | running | complete | partial | cancelled
```

### E1.3 Authored vs derived edges

**Only `artifact` and `ordering` edges may be authored.** `resource` (conflict) edges are **derived by the kernel** from overlapping `affected_paths` (Note 02 §8) and must not appear in a submitted plan. A plan authoring a `resource` edge fails validation.

The reason is in Note 02 §8: conflict edges exist because a planner *cannot reliably see* physical contention between logically independent nodes. Letting a planner author them invites it to author some and miss others, and the kernel would then have to reconcile authored against derived.

### E1.4 Node materialisation

A plan node is **not** a `WorkUnit`. The kernel materialises a WorkUnit from a node at dispatch:

- One node materialises **exactly once per plan version**, keyed `(plan_id@version, node_id)` — an idempotency key in Note 06 §5's sense.
- The node supplies objective, role, class, criteria, constraints, `affected_paths`, and budget request; the kernel supplies `instance_id`, the `ResolvedExecutionSpec` (Note 02 §7), the effective budget after `min()` (Note 04 §10), and derived conflict edges.
- Replanning materialises **new** WorkUnits under the new plan version. Nodes are never re-pointed at a different plan.

### E1.5 Validation rules

Extending Note 02 §9 step 2. All static, all pre-dispatch.

```
STRUCTURE
 · every edge endpoint resolves to a node in this plan
 · the authored graph is acyclic
 · no `resource` edge is authored                                  (E1.3)

ADMISSION                                                   (Note 04 §8)
 · every role_ref is admitted with may_appear_in_plans: true
 · a role_ref referenced by any active gate's execution.role_ref
   MAY NOT appear as a plan node                        ★ (Note 03 §1, B10)
 · no node declares class: verification                              (B10)

TYPES
 · for each artifact edge: producer.produces ∈ consumer.consumes
 · every node's expected_output == its role's produces

CRITERIA                                                    (Note 02 §3)
 · every node has ≥1 criterion
 · every criterion declares a class and resolves to an active gate
 · every node has ≥1 C0 or C1 criterion                     ★ rule 4
 · every referenced constraint_id exists in its source

BUDGET
 · budget_aggregate ≤ the parent unit's or instance's remaining ceiling
 · every node's budget > 0 on every axis

LINEAGE / INTENT
 · supersedes resolves; replan_reason present iff supersedes is set
 · intent_ref resolves to an Intent, NEVER to a MemoryRecord
   of kind `objective`                                ★ (Note 05 §2.6)
```

★ **The verification-node check is the interesting one, and it is mechanically decidable.** A Role that appears as `execution.role_ref` in any active gate is a verification Role; it reaches work through gate execution, never through a plan. Checking the plan's `role_ref`s against the gate registry makes "a plan cannot forget to verify, and cannot schedule verification either" a static property rather than a convention.

★ **The `intent_ref` check** is the enforcement point for Note 05 §2.6's bright line: an `objective` may inform work but never spawn it. Without this check, `objective` becomes a backdoor Intent producing work with no approved plan behind it.

---

## E2 — Context rendering contract

**Target:** Note 01 §14, as a new step **7a** between ASSEMBLE and MANIFEST.
**Rationale:** Note 01 §14 stops at "ordered, delimited, labelled with provenance." Note 05 §16 shows a rendered memory block informally. Nothing specifies the contract — and it is the point where the Context Compiler's precedence model either reaches the model or does not.

### E2.1 The governing principle ★

> **An unlabelled context is an unattributable context.**

Note 05 §8 defines a precedence order — repository, then pinned artifacts, then policy-derived facts, then memory. **That order is a fiction unless the rendering makes it visible.** Precedence that exists only inside the compiler does nothing at inference time: a model that cannot distinguish repository ground truth from an advisory memory record has no basis for weighting them differently, however carefully the compiler ordered them.

### E2.2 Layer block structure

Every layer renders as a delimited block with a mandatory header. **No layer may be rendered without one.**

```
── <layer name> · <authority tier> · <provenance> [· <marks>] ──────────
<content>
[── truncated: <n> of <m> <units> omitted (<policy>) ──]
────────────────────────────────────────────────────────────────────────
```

| Header field | Required | Content |
|---|---|---|
| layer name | yes | The recipe layer that produced it |
| **authority tier** | yes | `ground-truth` \| `contract` \| `policy` \| `advisory` |
| provenance | yes | Commit SHA, artifact id@version, policy version, or memory id@version |
| marks | when applicable | `verified` \| `unverified` (Note 05 §8), `truncated`, `human-asserted` |

Authority tier maps directly onto Note 05 §8's precedence:

| Tier | Sources |
|---|---|
| `ground-truth` | Live repository state |
| `contract` | Pinned input artifacts, objective, acceptance criteria, constraints |
| `policy` | Policy-derived facts and bindings |
| `advisory` | Memory |

### E2.3 Truncation must be announced ★

> **Silent truncation is prohibited.** Any layer trimmed by the budget policy (Note 01 §14 step 6) renders an explicit truncation notice stating what was omitted and why.

A file cut at 200 lines that *looks* complete causes the model to reason confidently about code that is not there — and to conclude, correctly given what it sees, that a symbol does not exist. This is among the most common and least visible context failures, and it is entirely preventable at the rendering boundary.

The notice names the count and the policy (`truncate_by_priority`, `layer cap`), never the content.

### E2.4 Rules

1. **Deterministic.** The same `ContextManifest` renders byte-identically. Rendering is a pure function; this is what makes Note 02 §14's replay mode 2 hash comparison meaningful.
2. **Ordering follows the recipe's `assembly.order`** (Note 01 §12). Ordering is *deterministic*; **authority is carried by the label, not by position**, so a recipe may order layers for any reason without weakening attribution.
3. **Priority-1 layers are never truncated** (Note 01 §14) and therefore never carry a truncation notice.
4. **The manifest's `assembled_hash` is computed over the rendered output**, not over the layer set. Two different renderings of the same layers are two different contexts.
5. **Redaction is asserted at rendering.** A gate assertion that no secret-shaped content appears in the rendered output (Note 02 §15). Rendering is the last point before content leaves the kernel's control.
6. **No content may be rendered outside a labelled block.** No preamble, no interstitial commentary, no unattributed text. If the compiler wants to say something, it is a layer.

### E2.5 Worked fragment

From Note 05 §16, now conformant:

```
── objective · contract · wu_204 ───────────────────────────────────────
Add refund idempotency keys to POST /payments/refunds.
Acceptance criteria: b1 (C0) … b4 (C1) …
────────────────────────────────────────────────────────────────────────

── target_files · ground-truth · repo@c40b118 ──────────────────────────
<src/payments/refunds.ts — full contents>
────────────────────────────────────────────────────────────────────────

── neighbourhood · ground-truth · repo@c40b118 · truncated ─────────────
<callers and callees>
── truncated: 6 of 19 call sites omitted (layer cap 20k tokens) ──
────────────────────────────────────────────────────────────────────────

── memory · advisory · mem_0041@1.0.0 · unverified ─────────────────────
[heuristic · scope src/payments/** · asserted against commit a91f3c2;
 repository has changed since]
  The payments subsystem has weak test isolation; unit tests there share
  mutable fixture state. Prefer integration tests, or assert fixture reset
  explicitly, for changes under src/payments/**.
────────────────────────────────────────────────────────────────────────
```

The model can now see that the memory record is advisory *and* possibly stale, that six call sites are missing rather than absent, and that the target file is current repository state. None of that is inferable from the content alone.

---

## E3 — AIOS as a deferred evaluation

**Target:** Note 07 §18 (Deferred), one row.
**Rationale:** Gap analysis found AIOS solves the provider-adapter and MCP/sandbox transport problem we would otherwise rebuild, while solving none of our governance layer. Recorded as an implementation-substrate evaluation, **not** an architectural dependency.

| Item | Why |
|---|---|
| **Evaluate AIOS (agiresearch) and MCP tooling as the implementation substrate for the Tool Broker (§4) and Model Broker (§8)** | AIOS provides multi-provider LLM adapters and MCP/VM sandboxing that overlap §4 and §8's *plumbing*. It provides no capability-token enforcement, no per-attempt scoping, no metering suitable for `fail_closed` budgets, and no governance layer — all of which stay ours and sit above it. Its unit of work is **the agent-as-process**, which is incompatible with the WorkUnit model and must not be adopted anywhere. Maturity caveat: v0.2.2, Modes 3–4 ongoing. Evaluate at implementation; do not design around it. |

**Explicitly not changed by this amendment:** no invariant, no boundary, no schema. Note 07 §17's sixteen invariants stand as written, including that the Executor holds no credentials and that all model calls pass through the Model Broker — both of which constrain any substrate we adopt rather than being relaxed by it.

---

## E4 — Tool Registry

**Target:** Note 03 §8 (registry model), extended to tools. Referenced from Note 07 §4.
**Rationale:** Gates are registered, versioned, owned, fixture-tested, and signed (Note 03 §8, C2a). Artifact schemas have a registry proposed. **Tools have neither** — Note 07 defines how tool calls are *enforced* but never what a tool *is* as a governed object. Tools are the Executor's entire action surface, which makes them an odd thing to leave unversioned.

**Deliberately narrow: this reuses the gate registry model rather than introducing a second governance model.**

### E4.1 Inherited from Note 03 §8 without modification

Human-only authoring · named `owner` · semver with immutable published versions · `draft`/`active`/`deprecated`/`retired` lifecycle · retired-not-deleted (replay) · human approval to register · signed definitions and registry audit log (C2a) · **fixtures mandatory, including negative cases**.

**No Role may author, modify, or register a tool.** Same reasoning as gates: a system that can extend its own action surface has no action boundary.

### E4.2 The `Tool` object

```yaml
Tool:
  id, version, owner, status                    # as Note 03 §8
  description
  interface:
    args_schema:    SchemaRef
    result_schema:  SchemaRef
  effects:          read | write | execute | external      # ★ E4.3
  scope_kinds:      [logical root]              # workspace:// | repo:// | artifact://
  sandbox_requirements:
    network:        none | allowlist
    determinism:    required | not_required
  credential_scopes: [SecretScope]              # NAMED here; HELD by the broker
  fixtures:
    must_succeed:   [FixtureRef]
    must_deny:      [FixtureRef]                # ★ out-of-scope calls it must refuse
    must_error:     [FixtureRef]
```

### E4.3 `effects` — the one tool-specific addition ★

Note 04 §5 sets `external_effects: { may_send, may_deploy, may_spend }` to false for every Role, and Note 07 §11 relies on that. **But "does this tool send email" is currently not a machine-checkable property of anything** — the policy forbids a category with no mechanical membership test.

Declaring `effects` on the tool closes it: `external_effects: false` becomes a set-membership check at capability-token minting, rejecting any grant of a tool declared `effects: external`. A prohibition that was previously enforced by everyone remembering which tools are dangerous becomes a static check.

### E4.4 `must_deny` fixtures

The tool analogue of Note 03 §8's `must_fail`: a tool must demonstrate it **refuses an out-of-scope call**. A tool whose scope check has never rejected anything is indistinguishable from one that does not check — the same fail-open blindness, at the action surface rather than the verification surface.

### E4.5 Explicitly not included

Tool discovery or marketplace semantics · a per-instance tool catalogue (that is configuration, like the Role catalogue) · MCP transport specifics (Note 07 §18, E3) · dynamic or model-authored tool definitions (prohibited by E4.1).

---

## Ledger entries (for the controlled pass)

To be added to `AMENDMENTS-pending.md` when it is next updated:

| # | Section | Change | Raised by | Status | MVP |
|---|---|---|---|---|---|
| E1 | Note 02 §4, §8, §9 | `TaskPlan` artifact schema, authored-vs-derived edges, node materialisation, and eight validation rules including the verification-node and `objective`-as-`intent_ref` checks | Documentation plan §D.1 | **applied** | must-apply |
| E2 | Note 01 §14 | Context rendering contract: mandatory layer headers with authority tier, prohibition on silent truncation, determinism, hash over rendered output | Documentation plan §D.5 | **applied** | must-apply |
| E3 | Note 07 §18 | AIOS/MCP as a deferred implementation-substrate evaluation for the Tool and Model Brokers | AIOS gap analysis | **applied** | must-apply |
| E4 | Note 03 §8, ref. Note 07 §4 | Tool Registry: tools become registered, versioned, owned, signed, fixture-tested objects, reusing the gate registry model. Adds `effects` classification, which gives Note 04 §5's `external_effects: false` a mechanical membership test, and `must_deny` fixtures | Coverage review #11 | **applied** | must-apply |

Application wave: **E1 → wave 1 (object model); E2 → wave 1; E3 → any; E4 → wave 2 (verification/registry, alongside C2a and D3).**

---

*End of Amendment Set E.*

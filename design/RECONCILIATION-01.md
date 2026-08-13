# AI-Org OS — Reconciliation Pass 01

**Scope:** Adjudicate C1–C5, D1–D7, and verification findings V1–V3.
**Status:** Recommendations. **Nothing changed in the ledger's status column** — acceptance is the owner's act, as it is everywhere else in this architecture.
**Method:** Each item re-examined against Notes 01–05 as a set, not as it was raised. Four came back modified; two merged; none rejected outright, and §4 says why that is worth a second look.

---

## 1. Summary of recommendations

| # | Recommendation | Changed from as-raised? |
|---|---|---|
| C1 | Accept | — |
| C2 | **Accept, split and staged** | ★ Yes |
| C3 | Accept, with a clarification | Minor |
| C4 | **Accept as concept, defer in build** | ★ Yes |
| C5 | **Accept, strengthened** | ★ Yes |
| D1 | Accept | — |
| D2 | Accept | — |
| D3 | Accept | — |
| D4 | Accept | — |
| D5 | Accept | — |
| D6 | **Accept, narrowed** | ★ Yes |
| D7 | Accept | — |
| V1 | Accept → becomes **B9** | — |
| V2 + V3 | **Merge** → becomes **B10** | ★ Yes |

---

## 2. Items returned modified

### C2 — Registry protections: split and stage ★

**As raised:** signed gate definitions, two-person registration approval, registry audit log outside instance reach, no policy may reference an unsigned gate. Four things in one entry.

**Problem:** they have different costs and different urgency, and bundling them forces an all-or-nothing decision. Note 03 §19.5 itself said single-instance MVP is adequately served by "humans only." Two-person gate registration on a single-founder instance means one person cannot register a gate — which stops the MVP dead.

**Recommendation — split into C2a and C2b:**

| | Content | When |
|---|---|---|
| **C2a** | Gate definitions are signed; the kernel verifies before execution. Registry has an append-only audit log outside any instance's reach. No policy may reference an unsigned or unregistered gate. | **Build now.** Cheap, structural, and retrofitting signing later means re-registering every gate |
| **C2b** | Registration quorum. **Make it a `FloorPolicy` value**, not a hardcoded 2 — default `1` at single-instance, raised to `2` when a second instance is provisioned | **Defer** to instance #2 |

Making the quorum a floor value rather than a constant is the substantive change: it means the same code path serves a solo founder and a regulated fleet, and raising it is a policy edit rather than a code change.

---

### C4 — Fleet layer: accept the concept, defer the build ★

**As raised:** the instance model gains an explicit fleet layer — floor policy, model tier bindings, provisioning, principal attention budgets, registry trust root.

**Problem:** for a single-founder, single-instance MVP **there is no fleet**. Introducing the layer now adds a level to every composition path, every validation step, and every resolution of `ResolvedExecutionSpec`, for zero present benefit. This is the same error I warned against in the very first conversation — *build single-tenant with clean seams; multi-tenancy is a three-week refactor later and a permanent tax on velocity if carried from day one.* C4 as raised would carry it from day one.

**Recommendation:** accept C4 as a **named concept in the design** — Note 01 §13 gains the fleet layer so the composition direction is documented and nothing is designed that would preclude it — but **do not build it until instance #2 exists.** Until then:

- Floor policy = the single instance's own policy, which the owner already approves.
- Model tier binding = one table, at instance level.
- Principal attention budget (C1) = instance attention policy, since one principal owns one instance. **The aggregation logic C1 requires is real but dormant.**
- Registry trust root = C2a's signing, no quorum.

The seam that must exist from the start is that **nothing reads a tier binding, floor, or attention budget from the instance object directly** — they are read through a resolver that today returns instance values and later returns composed fleet∩instance values. That is the entire cost of keeping the option open, and it is small.

---

### C5 — Promotion rule validation: strengthened ★

**As raised:** class promotion rules validated against the bound repository at policy publication; a predicate matching zero files is a warning.

**Problem:** publication-time validation only catches the *initial* case. Note 04 §19.5's actual scenario is a team refactoring `src/auth/**` into `src/identity/**` **months after** the policy was published — the predicate was valid at publication, matches zero files now, and the autonomy guard is silently gone. As raised, C5 does not catch the case it was written for.

**Recommendation — extend to continuous evaluation:**

1. Validate at policy publication (as raised).
2. **Re-evaluate on repository change** and surface zero-match predicates as an instance health signal.
3. A promotion predicate that has matched zero files for a threshold period escalates to the policy owner.

Note this is deliberately a *signal*, not a gate — a zero-match predicate is not always wrong (a path may be legitimately unused), so failing dispatch on it would be disproportionate. It belongs in the same family as Note 03 §7's `indeterminate_rate` per gate: a slow-burning quality signal that is invisible unless someone measures it deliberately.

---

### D6 — Third durable category: narrowed ★

**As raised:** name a third durable category, "approved durable context," alongside configuration and runtime state.

**Problem:** the category would have **exactly one member — Memory.** That is speculative generality: an abstraction invented for a set of size one, which then has to be maintained, explained, and defended against future members that may never arrive.

I also considered the opposite fix — collapsing `MemoryRecord` into `Artifact` (kernel as producer, reusing Note 02 §4's content hash, provenance, supersession, and immutability). **I recommend against it.** "Artifact" means *output of work* consistently across Notes 02–03, and broadening it to include kernel-committed durable belief weakens a clear concept. The status enums also diverge meaningfully: `expired` has no artifact analogue and would be dead weight on every diff and report.

**Recommendation:** amend Note 01 §4 to state that its configuration/runtime dichotomy has **one named exception: Memory**, with the properties in Note 05 §3 — instance-scoped, versioned, immutable, non-deletable, human-approved, and readable only by the Context Compiler. Name the exception concretely. If a second member ever appears, generalise then, with two examples to generalise from.

---

### V2 + V3 — Merge ★

Both are the same defect: **Note 02 §16 treats verification as a plan-level concept**, which Note 03 §1 eliminated. V2 is the plan node (`n3`), V3 is the `class: verification` on `wu_103`. One amendment fixes both, and splitting them invites fixing one and forgetting the other.

**Recommendation:** merge into a single entry, **B10**.

---

## 3. Cross-amendment interactions found

Only visible when the set is examined together. None was apparent when the items were raised individually.

| Interaction | Consequence | Handling |
|---|---|---|
| **C3 × C1** ★ | Quorum multiplies attention cost. A `2 of 3` approval places a pending item on **all three** principals' budgets until resolved, not on two. A regulated instance with several quorum gates can exhaust three principals' budgets with a handful of changes | C1's aggregation must count a pending quorum approval against **every named approver**, not against the eventual signers. State it in C3 |
| **C3 × Note 02 §12** | Content-hash binding under quorum | **All** approvers bind to the same content hash. Any content change voids **every** approval collected so far — no partial carry-forward. State it in C3 |
| **C4 × C1 × C2b** | C1's aggregation and C2b's quorum both live at a fleet layer that C4 defers | Both are dormant-but-designed at MVP. The resolver seam in C4 is what keeps them cheap to activate |
| **D4 × C3** | Non-blocking memory approvals under quorum | D4 holds unchanged: a quorum memory approval is still non-blocking and still outside the pause calculation |
| **D7 × Note 04 lattice** | `memory_policy` must obey Narrow/Oblige only | Confirmed: no instance may loosen a Note 05 default. Already stated in D7 |
| **C2a × D3** | Both are structural prohibitions enforced at gate registration | Same enforcement point. Implement together |

---

## 4. Why nothing was rejected — and the honest caveat

Every item survived, which deserves suspicion: **I raised all of them**, so a pass that accepts all of them is weak evidence of anything.

What I can say is that the re-examination was not a formality — four of fourteen came back materially changed, two of those (C4, C5) because the original was **wrong or insufficient rather than merely imprecise**. C4 as raised would have imported multi-tenancy on day one, contradicting advice I gave in this project's first conversation. C5 as raised would not have caught the scenario it was written for.

The genuine gap this pass cannot close: **no amendment here was proposed by anyone other than me.** The A/B block had the same property. That is a structural limitation of the process rather than of any individual item, and it is the same problem Note 02 §17.3 named about verifiers — a reviewer that shares the author's blind spots produces correlated errors, and persona alone does not decorrelate them. If any of these deserve outside scrutiny, C4 (build sequencing) and D6 (object model) are the two where a second opinion would be worth most, because both are decisions about what *not* to build and those are the hardest to see from inside.

---

## 5. MVP relevance ★

The most useful output of looking at the whole set at once: which amendments must land before implementation, and which are multi-instance concerns that can wait.

### Must apply before implementation

| # | Why |
|---|---|
| A1–A11, B1–B8 | Already accepted. They define the object model |
| B9, B10 | Correct live inconsistencies in Note 02's schemas and example |
| C3 | `Approval` shape. Retrofitting quorum into an approval model is invasive |
| C5 | Promotion rules are the autonomy guard; the signal must exist from the start or there is no baseline |
| D1, D2, D3, D5 | Memory's core contract: taxonomy, recipe layer, gate prohibition, immutability |
| D4 | Non-blocking approvals. Getting this wrong creates rubber-stamping pressure immediately |
| D6 | Object model. Cheap now, invasive later |
| C2a | Gate signing. Retrofitting means re-registering every gate |

### Defer to instance #2

| # | Why |
|---|---|
| C1 | Aggregation logic is real but dormant with one principal and one instance |
| C2b | Registration quorum; a solo founder cannot satisfy a 2-of-2 |
| C4 | The fleet layer itself. Keep the resolver seam, build nothing above it |
| D7 | `memory_policy` matters when instances differ. One instance's policy is its owner's preference |

**Nine must-apply, four deferred.** The deferred four are exactly the multi-instance ones, which is the expected shape and a mild signal that the boundary between instance and fleet was drawn in roughly the right place.

---

## 6. Proposed ledger changes

On approval, the ledger would be updated as follows. **No status has been changed yet.**

| Action | Detail |
|---|---|
| Status `proposed` → `accepted` | C1, C3, D1, D2, D3, D4, D5, D7 |
| Split | C2 → **C2a** (accept, build now) + **C2b** (accept, deferred) |
| Amend then accept | C4 (concept accepted, build deferred, resolver seam required) |
| Amend then accept | C5 (extended to continuous re-evaluation) |
| Amend then accept | D6 (narrowed to a named exception, not a new category) |
| Amend then accept | C3 (add the quorum × attention and quorum × content-hash clarifications) |
| Promote finding → amendment | V1 → **B9** |
| Merge findings → amendment | V2 + V3 → **B10** |
| New column | **MVP relevance** — `must-apply` or `defer-to-instance-2` per §5 |

---

*End of Reconciliation Pass 01.*

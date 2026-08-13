# AI-Org OS — Design Note 08
## The Predicate Language

**Status:** Draft for review
**Scope:** A total, deterministic boolean language over a fixed fact surface. **No ranking, no retrieval, no query planning, no implementation.**
**Depends on:** Notes 01–07 and accepted amendments A1–A11, B1–B10, C1–C5, D1–D7
**Position:** Last of the three closing architecture notes (07 → 06 → **08**).

Three subsystems already ship predicate strings in worked examples — `artifact.type == CodeDiff` (Note 03 §9), `diff.touches(path:'src/auth/**')` (Note 04 §9), `scope_match(...)` (Note 05 §8). None is specified. Without a shared language each grows a dialect, and Note 04 §19.5 is explicit that the autonomy guarantee **is** the quality of these expressions.

---

## Table of contents

1. [Consumers, and a refinement on unification](#1-consumers-and-a-refinement-on-unification)
2. [The fact surface](#2-the-fact-surface)
3. [What is deliberately unaddressable](#3-what-is-deliberately-unaddressable)
4. [Types and operators](#4-types-and-operators)
5. [Termination is structural](#5-termination-is-structural)
6. [Three-valued logic and per-consumer fail-safe](#6-three-valued-logic-and-per-consumer-fail-safe)
7. [Coverage analysis: the C5 mechanism](#7-coverage-analysis-the-c5-mechanism)
8. [Evaluation contexts](#8-evaluation-contexts)
9. [Versioning](#9-versioning)
10. [Authoring and testing](#10-authoring-and-testing)
11. [Worked example](#11-worked-example)
12. [Challenges](#12-challenges)
13. [Invariants](#13-invariants)
14. [Deferred](#14-deferred)

---

## 1. Consumers, and a refinement on unification

Four call sites were identified in the documentation plan, with the recommendation *"do not unify recipe retrieval selectors."* That was directionally right and slightly too blunt. The refinement:

| Consumer | Shape | Uses this language? |
|---|---|---|
| Gate `applies_when` (Note 03 §9) | fact → bool | **Yes, entirely** |
| Class promotion rules (Note 04 §9) | fact → bool | **Yes, entirely** |
| Memory `scope_match` (Note 05 §8) | fact → bool | **Yes, entirely** |
| Recipe layer selector (Note 01 §12) | filter **+ rank + limit** | **Filter clause only** |

A recipe selector like *"ADRs tagged to affected subsystems, `still_valid = true`, max 12, recency-weighted"* is three operations. Only the first is a predicate.

```yaml
selector:
  filter: <Predicate>        # ← this note
  rank:   <RankSpec>         # ← deferred (Note 05 §15)
  limit:  int
```

**Partial reuse, not separation.** Forcing ranking into the predicate language would put `recency-weighted` somewhere in `applies_when`, where it is meaningless. Keeping filters out of the language would give recipes a second dialect of the same thing. Splitting at the filter boundary avoids both.

---

## 2. The fact surface

> **Predicates address a flat, finite, typed fact surface. They do not traverse objects.**

No `work_unit.attempts[0].tool_invocations`. Graph traversal makes cost unbounded, makes the reachable set impossible to audit, and makes every new field a silent extension of what predicates can see. Instead, each evaluation context exposes an **enumerated** set of facts.

### 2.1 Artifact surface

Serves gate `applies_when` **and** class promotion rules — they turn out to need the same facts, which is a useful simplification.

| Fact | Type | Notes |
|---|---|---|
| `artifact.type` | enum | `CodeDiff`, `ArchitectureDecision`, … |
| `artifact.schema_ref` | version | |
| `artifact.segments` | set\<string\> | **Names only**, and only `public`/`restricted` ones (§3) |
| `diff.paths` | pathset | |
| `diff.files_touched` | int | |
| `diff.insertions` / `diff.deletions` | int | |
| `diff.modifies_public_interface` | bool | Derived projection, not raw code |
| `diff.dependency_manifest_changed` | bool | |
| `unit.class` | enum | |
| `unit.role_ref` | version-ref | |
| `unit.affected_paths` | pathset | Declared scope |

Every `diff.*` fact is a **derived projection**, never raw content. A predicate cannot read code, and therefore cannot be steered by anything written in it.

### 2.2 Scope surface

Serves memory `scope_match` (Note 05 §9).

| Fact | Type |
|---|---|
| `scope.level` | enum (`org`/`project`/`domain`/`subsystem`/`path`) |
| `scope.selector` | string \| path |
| `unit.affected_paths` | pathset |
| `unit.class` | enum |
| `unit.domain` | string? |

### 2.3 The whitelist rule ★

The fact surface is a **whitelist, not a filter.** There is no expression that reaches a forbidden value, because no fact naming it exists. This is the same structural move as `FailureRecord`'s whitelist schema (Note 02 §11), segment visibility (Note 02 §5), and memory's disjoint source enumeration (Note 05 §7): the guarantee holds because the channel is absent.

Adding a fact is a design change requiring the same review as adding a gate — never a configuration convenience.

---

## 3. What is deliberately unaddressable

| Not addressable | Enforced by | Established in |
|---|---|---|
| `private` artifact segments (`reasoning_trace`, `self_assessment`) | No fact names them; `artifact.segments` exposes names of non-private segments only | Note 02 §5 |
| Any memory record or memory source | No memory facts in any surface | Note 05 §7, **D3** |
| `Attempt.raw_trace_ref` | Not on any surface | Note 02 §6 |
| Raw file contents | Only derived `diff.*` projections exist | §2.1 |
| Another instance's anything | No instance-qualified facts | Note 04 §13, Note 05 §9 |
| Live external state | No I/O in the language at all | Note 02 §14 |
| Other WorkUnits' internals | No cross-unit facts | Note 02 §15 |
| Wall-clock time | No time facts | Note 06 §13 |

The last one deserves a note: **predicates cannot read the clock at all**, not even through the kernel. A time-dependent predicate would be non-deterministic under replay and would make Note 03 §10's gate cache unsound.

---

## 4. Types and operators

Small and total by design.

**Types:** `bool`, `int`, `string`, `path`, `pathset`, `enum`, `version`, `scope`. No user-defined types. No null — absence is `unknown` (§6).

| Class | Operators |
|---|---|
| Boolean | `and`, `or`, `not` |
| Comparison | `==`, `!=`, `<`, `<=`, `>`, `>=` (int, version) |
| Set | `in`, `subset_of`, `intersects`, `empty` |
| Path | `matches(glob)`, `under(prefix)` |
| Scope | `contains`, `overlaps` |

### No regular expressions ★

Globs only. Regex admits catastrophic backtracking — evaluation time unbounded in the input — which would break §5's structural termination and, with it, the determinism C0 gates require (Note 03 §6). Globs are bounded by construction.

Some legitimate patterns become awkward. That is the price, and it is the right one: a predicate language that can hang is a predicate language that cannot run inside pre-dispatch validation.

---

## 5. Termination is structural

No recursion. No loops. No function definitions. No unbounded quantifiers. No aggregation over unbounded collections.

An expression is a finite tree over a finite fact surface, so evaluation is bounded by `O(|expression| × |largest declared set|)` — both bounded, both known before evaluation.

**Termination is a property of the language, not a timeout.** ★ A timeout would make evaluation depend on machine speed and load, which is non-determinism — and predicates run inside kernel validation (Note 02 §9) and gate scheduling, where Note 03 §6 requires determinism and Note 03 §10's cache assumes it. A safety net here would quietly invalidate both.

---

## 6. Three-valued logic and per-consumer fail-safe ★

Evaluation yields `true`, `false`, or **`unknown`**.

`unknown` arises when a fact reference cannot be resolved — a projection unavailable for this artifact type, a fact absent from this surface. It is **not** the same as `false`.

| a | b | `a and b` | `a or b` |
|---|---|---|---|
| unknown | false | **false** | unknown |
| unknown | true | unknown | **true** |
| unknown | unknown | unknown | unknown |

`not unknown = unknown`.

### Each consumer resolves `unknown` in its own conservative direction

This is the part that matters, and a uniform rule would be wrong.

| Consumer | `unknown` resolves to | Because |
|---|---|---|
| Gate `applies_when` | **applies** | When in doubt, verify |
| Class promotion rule | **promote** | When in doubt, be stricter |
| Memory `scope_match` | **exclude** | When in doubt, do not inject advisory content |
| Recipe filter clause | **exclude** | Same |

A single `unknown → false` rule would silently disable gates and promotion rules — the precise failure C5 exists to catch. Conservatism means *more verification* for gates and *less content* for memory, and those point in opposite boolean directions.

---

## 7. Coverage analysis: the C5 mechanism ★

C5 concerns a promotion rule whose paths were renamed months after publication — `src/auth/**` becomes `src/identity/**`. Critically, **that predicate does not evaluate to `unknown`.** The fact surface resolves perfectly; `diff.paths` simply does not match. It returns `false`, correctly, forever, and the autonomy guard is gone.

Runtime three-valued logic cannot catch this. It needs a **static analysis**, run at policy publication and re-run on repository change (per C5 as amended):

```
CoverageReport(predicate, repository_snapshot):
  path_terms:        [ every glob/prefix literal in the expression ]
  matched_terms:     [ terms matching ≥1 path in the snapshot ]
  zero_match_terms:  [ terms matching nothing ]        ★
  verdict:  covered | partial | ZERO_COVERAGE
```

`ZERO_COVERAGE` on a promotion rule is a **health signal**, not a gate failure — a path may be legitimately unused, and failing dispatch on it would be disproportionate. A term matching zero paths for a threshold period escalates to the policy owner.

Two distinct mechanisms, often confused: **`unknown` means the language could not resolve a fact; `ZERO_COVERAGE` means it resolved fine and can never fire.** Both are needed and neither substitutes for the other.

---

## 8. Evaluation contexts

| Consumer | Evaluated | Surface | Evaluator |
|---|---|---|---|
| Gate `applies_when` | Gate profile composition and gate scheduling | Artifact | Kernel |
| Class promotion rule | **Post-harvest, pre-verification** (Note 04 §9) | Artifact | Kernel |
| Memory `scope_match` | Context compile (Note 05 §8) | Scope | Context Compiler |
| Recipe filter clause | Context compile | Layer-specific | Context Compiler |

**Only the kernel and the Context Compiler evaluate predicates.** Executors do not (Note 07 §12), gates do not — a gate receives the fact that it applies, never the expression that decided so.

**Purity:** no I/O, no clock, no randomness, no network, no mutation. Same inputs, same output, always. This is what allows evaluation inside pre-dispatch validation, where it must be cheap and must not fail.

---

## 9. Versioning

Predicates are embedded in versioned config — gate bindings, class policy, recipe layers — and are versioned with their host. The **language** is versioned separately:

```yaml
predicate_language_version: 1.0.0
```

An expression is evaluated under the language version pinned in the `ResolvedExecutionSpec` (Note 02 §7). A language change can alter the meaning of an unchanged expression, so **a language upgrade is a config event requiring an eval pass**, exactly like a model upgrade (Note 01 §11).

Semver for the language: **patch** = messages and diagnostics; **minor** = new facts or operators, no existing expression changes meaning; **major** = anything that could change an existing expression's result.

---

## 10. Authoring and testing

Predicates are human-authored configuration that determines whether verification runs. They get the same treatment as gates, reusing Note 03 §8 rather than inventing a parallel process:

| Requirement | Mirrors |
|---|---|
| Fixtures where the predicate **must fire** | Note 03 §8 `must_pass` |
| Fixtures where it **must not fire** | Note 03 §8 `must_fail` ★ |
| Coverage report at publication | §7, C5 |
| Human approval with its host config | Note 04 §16 |

The negative fixture carries the same weight it does for gates: **a promotion rule that has never fired is indistinguishable from one that cannot.**

---

## 11. Worked example

Continuing the password-reset case and Note 04 §19.5's scenario.

### Gate applicability

```
artifact.type == CodeDiff and diff.dependency_manifest_changed
```

Binds `gate://license.compatible@2.0.0` (Note 04 §17, Meridian). On `diff_0212` — a `CodeDiff` with no manifest change — this is `false`, and the licence gate does not run. Cheap, static, no ambiguity.

### Class promotion

```
unit.class == mechanical_change and (
    diff.paths matches "src/auth/**"
 or diff.paths matches "**/migrations/**"
 or diff.modifies_public_interface
)
```

Evaluated post-harvest on the real diff, so the class is a **claim the kernel checks** (Note 02 §17.1) rather than a self-assessment. `diff_0212` touches `src/routes/auth/**` — a `matches` hit — so a unit declared `mechanical_change` is promoted to `contract_change` and acquires `gate://security.review@1.4.0` before anything is accepted.

### The C5 failure, caught

Six months later the team moves `src/auth/**` to `src/identity/**`.

| Mechanism | Result |
|---|---|
| Runtime evaluation | `false` — **silent**. Every auth change now runs unpromoted |
| Three-valued logic | Not triggered. Nothing was unresolvable |
| **Coverage analysis (§7)** | `zero_match_terms: ["src/auth/**"]` → `ZERO_COVERAGE` → **escalates to the policy owner** |

The autonomy guard was lost at the refactor and recovered at the next repository-change coverage run. This is the case C5 was amended for, and it is the reason coverage analysis is a separate mechanism rather than a special case of `unknown`.

### Memory scope

```
scope.level == path and scope.selector overlaps unit.affected_paths
```

Selects `mem_0041` (heuristic on `src/payments/**`) for a refunds unit. If `unit.affected_paths` were somehow unresolvable, the result is `unknown` → **exclude** (§6) — no advisory content injected under uncertainty.

---

## 12. Challenges

### 12.1 The fact surface will be under constant pressure to grow

Every new fact is a new thing to keep deterministic, a new entry in the audit of what predicates can see, and a new candidate for accidental content exposure. The pressure will be continuous and each request will look small.

It needs an owner and a registration process with the same weight as gate registration (Note 03 §8). **A fact added casually is a security review skipped.**

### 12.2 Three-valued logic is unfamiliar

Authors will write predicates assuming two values and be surprised by `unknown` propagation — particularly that `unknown and false = false` while `unknown and true = unknown`.

Mitigation: fixtures (§10), and a lint warning when a predicate has a reachable `unknown` path without the author appearing to have considered it. This will still cause confusion.

### 12.3 Globs are weaker than authors will want

§4 accepts awkwardness in exchange for bounded evaluation. The first person who wants a negative-lookahead pattern will find this irritating and will be right that regex would be more expressive. The answer stays no.

### 12.4 Coverage analysis is only as good as its snapshot

§7 runs against a repository snapshot. A predicate covering a path that exists but is dormant reports `covered` while providing no real protection. Coverage proves a term *can* match, never that it *will* on relevant changes.

### 12.5 The temptation to add one traversal

At some point a predicate will need something reachable only by walking a relation — "was this file touched by a prior attempt," "does this role usually…". Each will seem like one small exception, and each converts a bounded language into a query language with unbounded cost and an unauditable reachable set.

If a predicate genuinely needs derived history, the correct move is to **compute it into a fact** — a named, versioned, deterministic projection added to the surface under §12.1's review — never to let the language walk there.

---

## 13. Invariants

1. **Predicates are total and deterministic.** Same inputs, same output, always.
2. **Termination is structural** — no recursion, loops, unbounded quantifiers, or regex — never a timeout.
3. **Predicates address a flat, finite, enumerated fact surface.** No object traversal.
4. **The fact surface is a whitelist.** Adding a fact is a reviewed design change.
5. **No predicate can address a `private` segment, any memory source, a raw file's contents, another instance, or the clock.**
6. **All `diff.*` facts are derived projections**, so a predicate can never be steered by repository content.
7. **Evaluation is three-valued**; `unknown` is distinct from `false`.
8. **Each consumer resolves `unknown` in its own conservative direction** — gates apply, promotions promote, memory excludes.
9. **`unknown` and `ZERO_COVERAGE` are different mechanisms** and neither substitutes for the other.
10. **Only the kernel and Context Compiler evaluate predicates.** Executors and gates never do.
11. **Predicates carry positive and negative fixtures**, per Note 03 §8.
12. **The language is versioned independently of its host config**; an upgrade requires an eval pass.
13. **Recipe selectors use this language for their filter clause only.** Ranking and limits are not predicates.

---

## 14. Deferred

| Item | Why |
|---|---|
| `RankSpec` — ordering within a retrieved set | Needs real data (Note 05 §15). Not a predicate concern |
| Retrieval beyond the filter clause | §1 |
| Aggregate functions (`count`, `sum` over unbounded sets) | §5 termination; add as named facts if genuinely needed |
| Cross-unit and historical facts | §12.5 — compute into a fact, do not extend the language |
| Concrete syntax (infix vs s-expression vs YAML-embedded) | Presentation. The semantics here are syntax-independent |
| Ignore-rule vocabulary for Note 07 §16.1 | Path-shaped; likely reuses `matches`/`under`, decided at implementation |
| Static type checking at authoring time | Desirable; a tooling concern, not a language-contract one |

---

*End of Design Note 08.*

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskPlan, PlanNode } from './types.ts';
import { EventStore } from './events.ts';
import { InMemorySpendLedger } from './broker.ts';
import { Kernel } from './kernel.ts';
import { makeResolver } from './resolve.ts';
import { MemoryStore } from './context.ts';
import { anthropicProvider } from './provider-anthropic.ts';
import { buildRegistry, POLICY, CRITERIA, layerSources, makeFixtureRepo, approvalFor } from './slice01.ts';
import { git } from './harvest.ts';

/**
 * First real two-node execution bridge (CLAUDE.md §11 checkpoint).
 *
 * Runs TWO real `mechanical_change` WorkUnits, sequentially, against a REAL
 * `git` repository (the Slice 01 fixture repo, unmodified) with a REAL
 * Anthropic provider — the same Role, gate profile, and instance policy as
 * Slice 01 / Slice 1.5, imported unchanged from slice01.ts. Node 2 depends
 * on Node 1 via an `ordering` edge only: independent objectives, no artifact
 * consumption. This is the smallest workload that exercises, live: the
 * dependency-admission gate (kernel.ts `admit()`), Slice 3's `artifact`-only
 * input-pinning guard (proving an `ordering` edge pins nothing), and a real
 * recorded human Approval driving `accept()` — none of which any existing
 * real-model runner (harness.ts) exercises today.
 *
 * ## Why a baseline bridge is required, and why it's done here rather than
 * in the kernel
 *
 * `tests.affected_pass` (gates.ts) is not diff-scoped: it unconditionally
 * reads `src/app.js` from whichever commit a unit's workspace was checked
 * out from, regardless of what that unit itself touched. The pristine
 * fixture baseline contains two `oldFn()` call sites by construction
 * (`makeFixtureRepo()`), so ANY second unit bound to `mechanical_change`'s
 * gate profile — including one that never touches `app.js` — will fail this
 * gate unless its baseline already reflects Node 1's migration. Node 1's
 * attempt workspace is already `git add -A`'d by `harvest()` before this
 * script ever sees it; committing it in place and capturing the resulting
 * `HEAD` is the smallest way to produce that baseline, with zero new
 * kernel/harvest logic — a plain `git commit` on state the kernel already
 * staged.
 *
 * `Kernel.materialise()` locks `baselineCommit` on a unit's first call and
 * nothing in `runAttempt()`/`provisionWorkspace()` can override it
 * afterward (kernel.ts has no such parameter). To still demonstrate Node 2
 * genuinely deferring on Node 1 (not merely never observing the deferred
 * state), Node 2 is materialised EARLY, before Node 1 finishes, on the
 * original baseline — `admit()` is called at that point and is expected to
 * return `dependency_unmet`. Once Node 1 is accepted and the bridge commit
 * exists, this script then replaces `kernel.units.get(u2.id)!.unit` with a
 * copy carrying the bridged `baselineCommit`, using the SAME public,
 * already-mutable `UnitState.unit` field the kernel's own Slice 3 code
 * writes to (`st.unit = {...st.unit, inputs: [...]}`, kernel.ts `admit()`)
 * and that the test suite already pokes directly (e.g. T-D27). This is a
 * driver-level adjustment of already-public kernel state, not a kernel code
 * change — no file other than this one is modified.
 *
 * Deliberately NOT wired into `npm test` / `npm run acceptance`, same as
 * harness.ts. Invoke directly:
 *
 *   node --experimental-strip-types src/harness-2node.ts [--model claude-sonnet-5] [--dry-run]
 *
 * Requires ANTHROPIC_API_KEY for a real run. Spends real money and writes
 * real commits into a disposable temp-dir copy of the Slice 01 fixture
 * repo — never ai-org-os itself, never rental-intel.
 */

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(msg: string): void {
  console.error(`FAILED: ${msg}`);
  process.exitCode = 1;
}

/** Independent, non-conflicting Node 2 objective: does not touch src/app.js,
 * stays CommonJS (module.exports), so it never trips api.schema_unchanged. */
const NODE2_OBJECTIVE =
  'Add a new file src/util.js that exports a function double(x) returning x * 2, ' +
  'using CommonJS module.exports (consistent with the rest of this repository). ' +
  'Do not modify any existing file.';

// Harness-local safety cap (CLAUDE.md §11 checkpoint follow-up): the effective
// per-attempt costCeiling resolved by resolve.ts is
// min(role.perAttempt.costCeiling=3.0, policy.perWorkUnitCap.execution=3.0,
// node.budget.execution, plan.budgetAggregate.execution) — none of which this
// file may change except the two node-local terms. Setting both to 0.10
// makes THIS harness's node.budget.execution the binding (smallest) term for
// both nodes, independent of the $3.00 role/policy ceilings, which remain
// untouched production values.
//
// This ceiling is per-ATTEMPT, not per-unit (kernel.ts runAttempt() reserves
// the full costCeiling fresh on every call — see T-L7). With n2's retry loop
// (MAX_N2_ATTEMPTS = 2) below, the true worst case is 3 reservations of this
// ceiling, not 2: n1 (1 attempt) + n2 (up to 2 attempts) = 3 x $0.10 = $0.30
// total hard ceiling. (plan.budgetAggregate.execution below is NOT what
// enforces this — it only feeds resolve.ts's `planRemaining` term in
// min(3.0, 3.0, node.budget.execution, planRemaining), and node.budget.
// execution is already the tightest term there, so the aggregate never
// binds. The $0.30 ceiling above comes purely from 3 independent per-attempt
// reservations against this constant.)
const PER_NODE_COST_CEILING = 0.10;

function buildPlan(): TaskPlan {
  const n1: PlanNode = {
    nodeId: 'n1',
    objective: 'Replace all oldFn() call sites in src/** with newFn().',
    roleRef: 'implementer@1.0.0', klass: 'mechanical_change', expectedOutput: 'CodeDiff',
    acceptanceCriteria: CRITERIA, constraints: [], affectedPaths: ['src/**'],
    budget: { execution: PER_NODE_COST_CEILING, verification: 0.0 },
    approvalsRequired: [{ kind: 'pre_merge', subject: 'artifact', blocking: true }],
  };
  const n2: PlanNode = {
    nodeId: 'n2',
    objective: NODE2_OBJECTIVE,
    roleRef: 'implementer@1.0.0', klass: 'mechanical_change', expectedOutput: 'CodeDiff',
    acceptanceCriteria: CRITERIA, constraints: [], affectedPaths: ['src/**'],
    budget: { execution: PER_NODE_COST_CEILING, verification: 0.0 },
    approvalsRequired: [{ kind: 'pre_merge', subject: 'artifact', blocking: true }],
  };
  return {
    id: 'plan_2node', version: '1.0.0', instanceId: 'slice01', intentRef: 'int_2node',
    nodes: [n1, n2],
    edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }],
    // Must be >= the sum of per-node execution budgets above, or it becomes
    // the (wrongly tighter) binding term via resolve.ts's `planRemaining`
    // parameter (kernel.ts passes plan.budgetAggregate.execution verbatim,
    // undecremented, to EACH node's resolveSpec call). 2 x 0.10 = 0.20 — this
    // is a non-binding label, not the enforced ceiling; see the comment above
    // PER_NODE_COST_CEILING for the true $0.30 worst case (3 per-attempt
    // reservations, which this field has no visibility into).
    budgetAggregate: { execution: 2 * PER_NODE_COST_CEILING, verification: 0.0 },
    status: 'approved',
  };
}

function main(): void {
  const model = arg('--model') ?? 'claude-sonnet-5';
  const dryRun = process.argv.includes('--dry-run');
  const plan = buildPlan();

  if (dryRun) {
    console.log('dry run — 2-node plan only; no repo, no admission, no model call.');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), 'aios-2node-'));
  const repoRoot = join(tmp, 'repo');
  const baseline = makeFixtureRepo(repoRoot);
  console.log(`repo: ${repoRoot}`);
  console.log(`baseline: ${baseline}`);

  const registry = buildRegistry();
  const events = new EventStore(join(tmp, 'events.jsonl'));
  const memory = new MemoryStore();
  const ledger = new InMemorySpendLedger();
  const kernel = new Kernel({
    instanceId: 'slice01', registry, policy: POLICY,
    resolver: makeResolver({ standard: [model], frontier: [model], fast: [model] }, 'binding://2node'),
    events, repoRoot, workspacesRoot: join(tmp, 'ws'),
    makeProviders: () => [anthropicProvider({ name: model, model })],
    layerSources: layerSources(registry), memory, ledger, leaseTtlS: 900, denialBudget: 5,
  });

  const n1node = plan.nodes[0]!;
  const n2node = plan.nodes[1]!;

  // ---- Node 1 ----
  const u1 = kernel.materialise(plan, n1node, baseline);
  console.log(`\n[n1] materialised: ${u1.id}`);

  // ---- Node 2, materialised EARLY (original baseline) purely to prove the
  // dependency-admission gate defers it for real before Node 1 finishes.
  // Its baselineCommit is corrected below, after the bridge, before dispatch.
  const u2 = kernel.materialise(plan, n2node, baseline);
  console.log(`[n2] materialised: ${u2.id} (baseline not yet bridged)`);

  const preAdmit2 = kernel.admit(u2.id);
  console.log(`[n2] admit while n1 incomplete: ${JSON.stringify(preAdmit2)}`);
  if (preAdmit2.admitted) { fail('node 2 admitted before node 1 finished — dependency gate did not defer it'); return; }

  const admit1 = kernel.admit(u1.id);
  console.log(`[n1] admit: ${JSON.stringify(admit1)}`);
  if (!admit1.admitted) { fail(`node 1 not admitted: ${admit1.reason}`); return; }

  const lease1 = kernel.acquireLease(u1.id, 'driver');
  if (!lease1) { fail('node 1 lease not acquired'); return; }

  console.log('[n1] running real attempt...');
  const { attempt: attempt1 } = kernel.runAttempt(u1.id, () => 'unused — real provider ignores this');
  console.log(`[n1] attempt ${attempt1.id}: ${attempt1.status}, model calls: ${attempt1.modelInvocations.length}, tool calls: ${attempt1.toolInvocations.length}, cost: ${ledger.spentFor(attempt1.id)}`);

  const st1 = kernel.expect(u1.id);
  console.log(`[n1] unit status: ${st1.status}`);
  for (const g of st1.gateResults) console.log(`  gate ${g.gateRef}: ${g.verdict}`);
  if (st1.status !== 'awaiting_approval') { fail(`node 1 did not reach awaiting_approval (got ${st1.status})`); return; }

  const art1 = st1.artifacts[st1.artifacts.length - 1]!;
  const diff1 = String(art1.segments.find((s) => s.name === 'diff')?.content ?? '');
  console.log(`[n1] artifact ${art1.id}, contentHash ${art1.contentHash}, diff length ${diff1.length} chars`);
  if (diff1.trim().length === 0) { fail('node 1 artifact has an empty diff'); return; }

  kernel.recordApproval(approvalFor('merge', art1.id, art1.contentHash));
  const accept1 = kernel.accept(u1.id, art1.id);
  console.log(`[n1] accept: ${JSON.stringify(accept1)}`);
  if (!accept1.accepted) { fail(`node 1 not accepted: ${accept1.reason}`); return; }

  // ---- Bridge: commit node 1's already-staged worktree, capture new baseline ----
  const ws1 = attempt1.workspaceRef!;
  execFileSync('git', ['-c', 'user.email=driver@aios', '-c', 'user.name=aios-driver', 'commit', '-q', '-m', 'n1: migrate oldFn() call sites to newFn()'], { cwd: ws1 });
  const bridgedBaseline = git(ws1, ['rev-parse', 'HEAD']).trim();
  console.log(`\n[bridge] committed node 1 worktree; new baseline: ${bridgedBaseline}`);

  // Correct Node 2's baselineCommit now that the bridge exists — see the
  // module doc comment for why this is a driver-side state update on
  // already-public kernel structures, not a kernel code change.
  const st2pre = kernel.expect(u2.id);
  st2pre.unit = { ...st2pre.unit, baselineCommit: bridgedBaseline };
  console.log(`[n2] baseline corrected to bridged commit: ${bridgedBaseline}`);

  // ---- Node 2 ----
  const admit2 = kernel.admit(u2.id);
  console.log(`\n[n2] admit after n1 accepted: ${JSON.stringify(admit2)}`);
  if (!admit2.admitted) { fail(`node 2 not admitted: ${admit2.reason}`); return; }

  const inputsAfterAdmit = kernel.expect(u2.id).unit.inputs;
  console.log(`[n2] WorkUnit.inputs after admission (ordering edge — must be empty): ${JSON.stringify(inputsAfterAdmit)}`);
  if (inputsAfterAdmit.length !== 0) { fail('node 2 unexpectedly has a non-empty inputs pin for an ordering-only dependency'); return; }

  const lease2 = kernel.acquireLease(u2.id, 'driver');
  if (!lease2) { fail('node 2 lease not acquired'); return; }

  console.log('[n2] running real attempt 1/2...');
  let attempt2Result = kernel.runAttempt(u2.id, () => 'unused — real provider ignores this');
  console.log(`[n2] attempt ${attempt2Result.attempt.id}: ${attempt2Result.attempt.status}, model calls: ${attempt2Result.attempt.modelInvocations.length}, tool calls: ${attempt2Result.attempt.toolInvocations.length}, cost: ${ledger.spentFor(attempt2Result.attempt.id)}`);

  // Caller-driven retry (CLAUDE.md §3a item 5): `attempt_failed` never
  // auto-promotes — admit() must be called again to make the retry/exhaustion
  // decision, and only proceeds if it grants `admitted: true` (respects
  // no_progress / on_failure escalation / maxAttempts, exactly as designed).
  // Bounded at ONE retry (2 attempts total), not the Role's full maxAttempts
  // of 3: real evidence across 5 live runs shows n2 either succeeds on a
  // fresh attempt (cEMtWu) or fails cheaply (~$0.008, a single `done`-shaped
  // turn — Lx5KMr, PuYjDz, I0cXWO, and this run's node.budget.execution
  // ceiling was never approached in ANY of them) — a second attempt is where
  // the evidence says the marginal value is, not a third.
  const MAX_N2_ATTEMPTS = 2;
  let n2Attempts = 1;
  while (kernel.expect(u2.id).status === 'attempt_failed' && n2Attempts < MAX_N2_ATTEMPTS) {
    n2Attempts += 1;
    console.log(`\n[n2] attempt_failed — retrying (attempt ${n2Attempts}/${MAX_N2_ATTEMPTS})...`);
    const retryAdmit = kernel.admit(u2.id);
    console.log(`[n2] retry admit: ${JSON.stringify(retryAdmit)}`);
    if (!retryAdmit.admitted) { fail(`node 2 retry not admitted: ${retryAdmit.reason}`); return; }
    // No re-lease here: the lease acquired once at `lease2` above (line 221)
    // is session-scoped, not per-attempt (kernel.ts acquireLease()'s
    // compare-and-set correctly REJECTS a redundant second acquisition while
    // it's still valid — T-I7 already proves one lease covers a full
    // admit()-gated retry). Reuse it directly.
    attempt2Result = kernel.runAttempt(u2.id, () => 'unused — real provider ignores this');
    console.log(`[n2] attempt ${attempt2Result.attempt.id}: ${attempt2Result.attempt.status}, model calls: ${attempt2Result.attempt.modelInvocations.length}, tool calls: ${attempt2Result.attempt.toolInvocations.length}, cost: ${ledger.spentFor(attempt2Result.attempt.id)}`);
  }
  const attempt2 = attempt2Result.attempt;

  const st2 = kernel.expect(u2.id);
  console.log(`\n[n2] unit status: ${st2.status} (after ${n2Attempts} attempt(s))`);
  for (const g of st2.gateResults) console.log(`  gate ${g.gateRef}: ${g.verdict}`);
  if (st2.status !== 'awaiting_approval') { fail(`node 2 did not reach awaiting_approval (got ${st2.status})`); return; }

  const art2 = st2.artifacts[st2.artifacts.length - 1]!;
  const diff2 = String(art2.segments.find((s) => s.name === 'diff')?.content ?? '');
  console.log(`[n2] artifact ${art2.id}, contentHash ${art2.contentHash}, diff length ${diff2.length} chars`);
  if (diff2.trim().length === 0) { fail('node 2 artifact has an empty diff'); return; }

  kernel.recordApproval(approvalFor('merge', art2.id, art2.contentHash));
  const accept2 = kernel.accept(u2.id, art2.id);
  console.log(`[n2] accept: ${JSON.stringify(accept2)}`);
  if (!accept2.accepted) { fail(`node 2 not accepted: ${accept2.reason}`); return; }

  // ---- Final summary ----
  console.log('\n========== FINAL STATE ==========');
  console.log(`plan status: ${kernel.planStatus(plan.id, plan.version)}`);
  console.log(`n1: status=${kernel.expect(u1.id).status} artifact=${art1.id} diffChars=${diff1.length}`);
  console.log(`n2: status=${kernel.expect(u2.id).status} artifact=${art2.id} diffChars=${diff2.length}`);
  console.log(`n2 inputs (ordering edge, expect []): ${JSON.stringify(kernel.expect(u2.id).unit.inputs)}`);
  console.log(`approvals recorded: ${kernel.approvals.length}`);
  console.log(`total spend: n1=${ledger.spentFor(attempt1.id)} n2=${ledger.spentFor(attempt2.id)} account.spent=${kernel.account.spent}`);
  console.log(`events: ${events.all().length}`);

  kernel.disposeWorkspace(attempt1.workspaceRef);
  kernel.disposeWorkspace(attempt2.workspaceRef);
}

main();

import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { TaskPlan } from './types.ts';
import { EventStore } from './events.ts';
import { InMemorySpendLedger } from './broker.ts';
import { Kernel } from './kernel.ts';
import { makeResolver } from './resolve.ts';
import { MemoryStore } from './context.ts';
import { anthropicProvider } from './provider-anthropic.ts';
import { buildRegistry, POLICY, CRITERIA, layerSources } from './slice01.ts';

/**
 * Slice 1.5 harness (CLAUDE.md §11).
 *
 * Runs ONE real `mechanical_change` WorkUnit against a REAL repository with
 * a REAL model provider — the same Role, gate profile, and instance policy
 * as Slice 01 (imported unmodified from slice01.ts). Only the provider and
 * the target repository change.
 *
 * Deliberately NOT wired into `npm test` / `npm run acceptance`: those 80
 * tests are the machine's deterministic regression suite (Note 09 /
 * Appendix A split). Invoke this directly:
 *
 *   node --experimental-strip-types src/harness.ts \
 *     --repo <path to a git repo> \
 *     --objective "<text>" \
 *     [--paths "src/**"] [--model claude-sonnet-5] [--dry-run]
 *
 * Requires ANTHROPIC_API_KEY. Each run spends real money and writes a real
 * git worktree commit inside the target repo — read the plan with
 * --dry-run before running for real.
 */

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const repo = arg('--repo');
  const objective = arg('--objective');
  const paths = arg('--paths') ?? 'src/**';
  const model = arg('--model') ?? 'claude-sonnet-5';
  const dryRun = process.argv.includes('--dry-run');

  if (!repo || !objective) {
    console.error('usage: --repo <path> --objective "<text>" [--paths "src/**"] [--model <name>] [--dry-run]');
    process.exitCode = 1;
    return;
  }

  const resolvedRepo = resolvePath(repo);
  // CLAUDE.md §9: never modify rental-intel.
  if (resolvedRepo.toLowerCase().includes('rental-intel')) {
    console.error('refusing to target rental-intel (CLAUDE.md §9)');
    process.exitCode = 1;
    return;
  }

  const plan: TaskPlan = {
    id: 'plan_slice1_5', version: '1.0.0', instanceId: 'slice01', intentRef: 'int_slice1_5',
    nodes: [{
      nodeId: 'n1', objective, roleRef: 'implementer@1.0.0', klass: 'mechanical_change',
      expectedOutput: 'CodeDiff', acceptanceCriteria: CRITERIA, constraints: [],
      affectedPaths: [paths], budget: { execution: 3.0, verification: 0.0 },
      approvalsRequired: [{ kind: 'pre_merge', subject: 'artifact', blocking: true }],
    }],
    edges: [], budgetAggregate: { execution: 9.0, verification: 0.0 }, status: 'approved',
  };

  if (dryRun) {
    console.log('dry run — plan only; no admission, no workspace, no model call.');
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const baseline = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolvedRepo, encoding: 'utf8' }).trim();

  const tmp = mkdtempSync(join(tmpdir(), 'aios-harness-'));
  const registry = buildRegistry();
  const events = new EventStore(join(tmp, 'events.jsonl'));
  const memory = new MemoryStore();
  const ledger = new InMemorySpendLedger();
  const kernel = new Kernel({
    instanceId: 'slice01', registry, policy: POLICY,
    resolver: makeResolver({ standard: [model], frontier: [model], fast: [model] }, 'binding://slice1.5'),
    events, repoRoot: resolvedRepo, workspacesRoot: join(tmp, 'ws'),
    makeProviders: () => [anthropicProvider({ name: model, model })],
    layerSources: layerSources(registry), memory, ledger, leaseTtlS: 900, denialBudget: 5,
  });

  const unit = kernel.materialise(plan, plan.nodes[0]!, baseline);
  const admission = kernel.admit(unit.id);
  if (!admission.admitted) {
    console.error(`not admitted: ${admission.reason}`);
    process.exitCode = 1;
    return;
  }
  const lease = kernel.acquireLease(unit.id, 'harness');
  if (!lease) {
    console.error('lease not acquired');
    process.exitCode = 1;
    return;
  }

  const { attempt } = kernel.runAttempt(unit.id, () => 'unused — real provider ignores this');
  console.log(`attempt ${attempt.id}: ${attempt.status}`);
  console.log(`model calls: ${attempt.modelInvocations.length}, tool calls: ${attempt.toolInvocations.length}`);
  console.log(`cost: ${ledger.spentFor(attempt.id)}`);

  const st = kernel.units.get(unit.id);
  if (st) {
    console.log(`unit status: ${st.status}`);
    for (const g of st.gateResults) console.log(`  gate ${g.gateRef}: ${g.verdict}`);
  }

  kernel.disposeWorkspace(attempt.workspaceRef);
}

main();

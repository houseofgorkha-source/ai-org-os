import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TaskPlan, PlanNode, WorkUnit, WorkUnitStatus, Attempt, AttemptStatus, Artifact,
  Approval, FailureRecord, GateResult, Lease, Money, EffectiveBudget, ContextManifest, DenialRecord,
} from './types.ts';
import type { Registry } from './registry.ts';
import type { InstancePolicy, TierBindingResolver } from './resolve.ts';
import { resolveSpec } from './resolve.ts';
import { EventStore, makeEvent } from './events.ts';
import { ContextCompiler, MemoryStore } from './context.ts';
import type { GatherContext, LayerSource } from './context.ts';
import { InMemorySpendLedger, ModelBroker, ToolBroker, mintToken } from './broker.ts';
import type { ModelProvider } from './broker.ts';
import { runExecutor } from './executor.ts';
import { freezeWorkspace, harvest, dedupeArtifact, git } from './harvest.ts';
import { runGates } from './gates.ts';
import { quorumMet } from './validate.ts';
import { hashOf, nextId, now, nowMs, plusSeconds, sha256 } from './util.ts';

/**
 * The kernel (Note 06).
 *
 * Deterministic control plane. Contains NO model call: an LLM in the control
 * plane means orchestration state can be hallucinated, and every failure
 * becomes unfalsifiable.
 */

export interface BudgetAccount {
  reserved: Money;
  spent: Money;
  readonly dayCap: Money;
}

export interface KernelDeps {
  readonly instanceId: string;
  readonly registry: Registry;
  readonly policy: InstancePolicy;
  readonly resolver: TierBindingResolver;
  readonly events: EventStore;
  readonly repoRoot: string;
  readonly workspacesRoot: string;
  /** Factory, not instances: each attempt gets fresh providers so no state leaks across attempts. */
  readonly makeProviders: () => ModelProvider[];
  readonly layerSources: Map<string, LayerSource>;
  readonly memory: MemoryStore;
  readonly ledger: InMemorySpendLedger;
  readonly leaseTtlS: number;
  readonly denialBudget: number;
}

export interface UnitState {
  unit: WorkUnit;
  status: WorkUnitStatus;
  attempts: Attempt[];
  lease: Lease | null;
  epoch: number;
  reserved: Money;
  failures: FailureRecord[];
  gateResults: GateResult[];
  artifacts: Artifact[];
  manifests: ContextManifest[];
  progressHashes: string[];
  /** Real DenialRecords from each attempt's ToolBroker, keyed by attemptId — Note 07 §7. */
  denialsByAttempt: Map<string, DenialRecord[]>;
}

export interface Faults {
  readonly crashAfterExecutorBeforeHarvest?: boolean;
  readonly errorGates?: readonly string[];
  readonly flakyGates?: readonly string[];
  readonly expireLeaseDuringExecution?: boolean;
}

export class Kernel {
  private readonly d: KernelDeps;
  readonly units = new Map<string, UnitState>();
  readonly approvals: Approval[] = [];
  readonly account: BudgetAccount;
  private readonly compiler: ContextCompiler;

  constructor(deps: KernelDeps) {
    this.d = deps;
    this.compiler = new ContextCompiler(deps.layerSources);
    this.account = { reserved: 0, spent: 0, dayCap: deps.policy.budgetPolicy.perDayCap };
  }

  // ------------------------------------------------------- materialisation

  /** Idempotent under (plan@version, nodeId) — Note 06 §5. */
  materialise(plan: TaskPlan, node: PlanNode, baselineCommit: string): WorkUnit {
    const key = `${plan.id}@${plan.version}#${node.nodeId}`;
    const existing = [...this.units.values()].find((u) => materialKey(u.unit) === key);
    if (existing) return existing.unit;

    const spec = resolveSpec(node, this.d.registry, this.d.policy, this.d.resolver, plan.budgetAggregate.execution);
    const budget: EffectiveBudget = spec.effectiveBudget;

    // Note 02 §8 / E1.3: only `artifact` and `ordering` edges are authored;
    // `resource` conflicts are derived separately (admit(), unchanged).
    // Predecessors must already be materialised — materialise() stays a
    // per-node primitive; the caller is responsible for topological order.
    const dependsOn = plan.edges
      .filter((e) => e.to === node.nodeId)
      .map((e) => {
        const predKey = `${plan.id}@${plan.version}#${e.from}`;
        const pred = [...this.units.values()].find((u) => materialKey(u.unit) === predKey);
        if (!pred) {
          throw new Error(
            `materialise: predecessor node '${e.from}' for '${node.nodeId}' is not yet materialised — ` +
            `dependency edges require predecessors to be materialised first`,
          );
        }
        return { unitId: pred.unit.id, kind: e.kind };
      });

    const unit: WorkUnit = {
      id: nextId('wu'),
      instanceId: this.d.instanceId,
      planId: plan.id, planVersion: plan.version, planNodeId: node.nodeId,
      klass: node.klass, objective: node.objective, intentRef: plan.intentRef,
      inputs: [], expectedOutput: node.expectedOutput,
      acceptanceCriteria: node.acceptanceCriteria, constraints: node.constraints,
      executionSpec: spec, dependsOn, affectedPaths: node.affectedPaths,
      budget, approvalsRequired: node.approvalsRequired, baselineCommit,
    };
    this.units.set(unit.id, {
      unit, status: 'validated', attempts: [], lease: null, epoch: 0, reserved: 0,
      failures: [], gateResults: [], artifacts: [], manifests: [], progressHashes: [],
      denialsByAttempt: new Map(),
    });
    this.emit('workunit.validated', [unit.id], { planNodeId: node.nodeId }, null, plan.intentRef);
    return unit;
  }

  // -------------------------------------------------------------- dispatch

  /** A unit becomes `running` only on lease + reservation + workspace. */
  admit(unitId: string): { admitted: boolean; reason?: string } {
    const st = this.expect(unitId);
    if (st.status !== 'validated' && st.status !== 'ready' && st.status !== 'attempt_failed') {
      return { admitted: false, reason: `status ${st.status}` };
    }

    // Dependency graph (Note 02 §8, Note 06 §2.1). Any failed upstream
    // dependency blocks the unit regardless of edge kind — the decided
    // resolution to §6's ambiguity. An unresolved (non-terminal) dependency
    // defers admission without touching status, same "defer, never lock"
    // posture as the scope-conflict check below.
    let anyDependencyFailed = false;
    let anyDependencyPending = false;
    let failedDependency: { unitId: string; kind: string } | null = null;
    for (const dep of st.unit.dependsOn) {
      const depState = this.units.get(dep.unitId);
      if (!depState) continue;
      if (depState.status === 'accepted') continue;
      if (TERMINAL_UNIT_STATUSES.has(depState.status)) { anyDependencyFailed = true; failedDependency = dep; }
      else anyDependencyPending = true;
    }
    if (anyDependencyFailed) {
      // The entry guard above already limits st.status to validated/ready/
      // attempt_failed here, so this is always a fresh transition into blocked.
      st.status = 'blocked';
      this.emit('workunit.blocked', [unitId], { failedDependency: failedDependency!.unitId, kind: failedDependency!.kind });
      return { admitted: false, reason: 'dependency_failed' };
    }
    if (anyDependencyPending) return { admitted: false, reason: 'dependency_unmet' };

    const running = [...this.units.values()].filter((u) => u.status === 'running');
    if (running.length >= this.d.policy.budgetPolicy.maxRunningUnits) return { admitted: false, reason: 'max_running_units' };
    // Derived conflict edges: no two running units may overlap in scope.
    for (const r of running) {
      if (overlaps(r.unit.affectedPaths, st.unit.affectedPaths)) return { admitted: false, reason: 'scope_conflict' };
    }
    const ceiling = st.unit.budget.execution.costCeiling;
    if (this.account.reserved + this.account.spent + ceiling > this.account.dayCap) {
      return { admitted: false, reason: 'instance_budget_headroom' };
    }

    // Note 06 §2.1: `validated -> ready` once dependencies and admission are
    // satisfied. Smallest transition that keeps the status observable and
    // eventable without a separate scheduling pass (§6 ambiguity 4).
    if (st.status === 'validated') {
      st.status = 'ready';
      this.emit('workunit.ready', [unitId], {});
    }
    return { admitted: true };
  }

  acquireLease(unitId: string, holder: string): Lease | null {
    const st = this.expect(unitId);
    if (st.lease && Date.parse(st.lease.expiresAt) > nowMs()) return null;   // compare-and-set
    st.epoch += 1;
    const lease: Lease = {
      workUnitId: unitId, attemptId: '', epoch: st.epoch, holder,
      acquiredAt: now(), expiresAt: plusSeconds(now(), this.d.leaseTtlS),
    };
    st.lease = lease;
    this.emit('lease.acquired', [unitId], { epoch: st.epoch, holder });
    return lease;
  }

  expireLease(unitId: string): void {
    const st = this.expect(unitId);
    if (!st.lease) return;
    st.lease = { ...st.lease, expiresAt: new Date(nowMs() - 1000).toISOString() };
    this.emit('lease.expired', [unitId], { epoch: st.epoch });
  }

  // --------------------------------------------------------------- attempt

  runAttempt(unitId: string, script: (prompt: string, turn: number) => string, faults: Faults = {}): { attempt: Attempt; crashed?: boolean } {
    const st = this.expect(unitId);
    const ordinal = st.attempts.length + 1;
    const spec = st.unit.executionSpec;

    // Reservation is PESSIMISTIC: the full ceiling, held from dispatch to terminal.
    const reserve = st.unit.budget.execution.costCeiling;
    this.account.reserved += reserve;
    st.reserved += reserve;
    this.emit('budget.reserved', [unitId], { reserve });

    const attemptId = nextId('att');
    const epoch = st.epoch;
    const ws = this.provisionWorkspace(unitId, attemptId, st.unit.baselineCommit);
    const tools = new ToolBroker(this.d.registry, ws, this.d.denialBudget);
    const models = new ModelBroker(this.d.makeProviders(), this.d.ledger);

    const recipe = this.d.registry.getRecipe(spec.contextRecipeRef);
    const gctx: GatherContext = {
      repoRoot: this.d.repoRoot,
      headCommit: st.unit.baselineCommit,
      memory: this.d.memory,
      priorFailure: st.failures.length ? JSON.stringify(st.failures[st.failures.length - 1]) : null,
      readFile: (rel) => { try { return readFileSync(join(ws, rel), 'utf8'); } catch { return null; } },
      listFiles: () => { try { return git(ws, ['ls-files']).trim().split('\n'); } catch { return []; } },
    };
    const { rendered, manifest } = this.compiler.compile(st.unit, recipe, gctx);
    st.manifests.push(manifest);

    const token = mintToken(spec, attemptId, this.d.instanceId, ws, st.unit.budget.execution.wallClockS);
    const deadline = plusSeconds(now(), st.unit.budget.execution.wallClockS);

    let attempt: Attempt = {
      id: attemptId, workUnitId: unitId, ordinal, leaseEpoch: epoch,
      startedAt: now(), endedAt: null,
      executionSpecHash: spec.hash, contextManifestRef: manifest.id,
      renderedPromptHash: sha256(rendered), capabilityTokenRef: token.id, workspaceRef: ws,
      toolInvocations: [], modelInvocations: [], status: 'running',
      producedArtifact: null, rawTraceRef: null,
    };
    st.attempts.push(attempt);
    st.status = 'running';
    this.emit('attempt.started', [unitId, attemptId], { ordinal, epoch, specHash: spec.hash });

    const result = runExecutor(
      { attemptId, workUnitId: unitId, executionSpec: spec, renderedContext: rendered, contextManifestRef: manifest.id, capabilityToken: token, workspaceRef: ws, deadline },
      { tools, models, executionCeiling: st.unit.budget.execution.costCeiling },
    );

    for (const r of tools.records) this.emit(r.outcome === 'denied' ? 'tool.denied' : 'tool.invoked', [unitId, attemptId], { ...r });
    for (const r of models.records) this.emit('model.served', [unitId, attemptId], { ...r });
    st.denialsByAttempt.set(attemptId, tools.denialRecords);

    const status: AttemptStatus =
      result.termination === 'completed' ? 'completed'
      : result.termination === 'deadline' ? 'timed_out'
      : result.termination === 'denial_budget' ? 'denied'
      : 'failed';

    attempt = {
      ...attempt, endedAt: now(), status,
      toolInvocations: result.toolInvocations, modelInvocations: result.modelInvocations,
      rawTraceRef: `trace:${attemptId}`,
    };
    st.attempts[st.attempts.length - 1] = attempt;
    this.emit('attempt.' + status, [unitId, attemptId], { termination: result.termination });

    // Traces are PRIVATE and unaddressable by any recipe or predicate.
    traceStore.set(`trace:${attemptId}`, result.narrative);

    freezeWorkspace(ws);

    if (faults.crashAfterExecutorBeforeHarvest) {
      // Simulated kernel death. Nothing is harvested; reservation is still held.
      return { attempt, crashed: true };
    }

    this.postExecution(unitId, attempt, faults);
    return { attempt };
  }

  /** Everything after executor exit. Idempotent and re-runnable — T-K6. */
  postExecution(unitId: string, attempt: Attempt, faults: Faults = {}): void {
    const st = this.expect(unitId);

    // Fencing: harvest only if this attempt still holds the current epoch.
    if (attempt.leaseEpoch < st.epoch) {
      const idx = st.attempts.findIndex((a) => a.id === attempt.id);
      if (idx >= 0) st.attempts[idx] = { ...attempt, status: 'superseded' };
      this.emit('attempt.superseded', [unitId, attempt.id], { epoch: attempt.leaseEpoch, current: st.epoch });
      this.releaseReservation(st);
      this.disposeWorkspace(attempt.workspaceRef);
      return;
    }

    if (attempt.status === 'denied') {
      this.recordFailure(st, attempt, 'capability_denied', [], []);
      st.status = 'escalated';
      this.emit('escalation.raised', [unitId], { klass: 'capability_denied' });
      this.releaseReservation(st);
      return;
    }

    const h = harvest({
      workspaceRoot: attempt.workspaceRef!, baselineCommit: st.unit.baselineCommit,
      unit: st.unit, attemptId: attempt.id, contextManifestRef: attempt.contextManifestRef!,
    });
    const { artifact, created } = dedupeArtifact(st.artifacts, h.artifact);
    if (created) {
      st.artifacts.push(artifact);
      this.emit('artifact.constructed', [unitId, artifact.id], { contentHash: artifact.contentHash, filesTouched: h.filesTouched });
    }
    const idx = st.attempts.findIndex((a) => a.id === attempt.id);
    if (idx >= 0) st.attempts[idx] = { ...st.attempts[idx]!, producedArtifact: artifact.id };

    st.status = 'verifying';
    const gr = runGates(st.unit.executionSpec.effectiveGates.bindings, this.d.registry,
      { workspaceRoot: attempt.workspaceRef!, baselineCommit: st.unit.baselineCommit, unit: st.unit, artifact, faults });
    for (const r of gr.results) {
      st.gateResults.push(r);
      this.emit('gate.result', [unitId, artifact.id], { gateRef: r.gateRef, verdict: r.verdict });
    }

    if (gr.errors.length > 0 && !gr.blockingFailure && !gr.indeterminate) {
      // `error` is infrastructure: no FailureRecord, no attempt consumed.
      st.status = 'attempt_failed';
      st.attempts[idx >= 0 ? idx : st.attempts.length - 1] = { ...st.attempts[st.attempts.length - 1]!, status: 'failed' };
      this.emit('gate.error', [unitId], { gates: gr.errors.map((e) => e.gateRef) });
      this.releaseReservation(st);
      return;
    }
    if (gr.indeterminate) {
      st.status = 'escalated';
      this.emit('escalation.raised', [unitId], { klass: 'indeterminate', gate: gr.indeterminate.gateRef });
      this.releaseReservation(st);
      return;
    }
    if (gr.blockingFailure) {
      const failedCriteria = st.unit.acceptanceCriteria
        .filter((c) => gr.results.some((r) => r.gateRef.startsWith(c.check.gateRef.split('@')[0]!) && r.verdict === 'fail'))
        .map((c) => c.id);
      this.recordFailure(st, attempt, 'verification_failed', gr.results, failedCriteria, h);
      st.status = 'attempt_failed';
      this.releaseReservation(st);
      return;
    }

    st.artifacts[st.artifacts.findIndex((a) => a.id === artifact.id)] = { ...artifact, status: 'verified' };
    st.status = 'awaiting_approval';
    this.emit('artifact.verified', [unitId, artifact.id], {});
    this.releaseReservation(st);
  }

  private recordFailure(
    st: UnitState, attempt: Attempt, klass: FailureRecord['klass'],
    results: readonly GateResult[], failedCriteria: readonly string[],
    h?: { filesTouched: number; insertions: number; deletions: number },
  ): void {
    const failing = results.filter((r) => r.verdict === 'fail');
    const errors = results.filter((r) => r.verdict === 'error');
    const rec: FailureRecord = {
      klass,
      detectedBy: failing[0]?.gateRef ?? 'kernel',
      failedCriteria: [...failedCriteria],
      violatedConstraints: [],
      // ALL results are carried, not just the first: batch cheap evidence.
      gateResults: results.filter((r) => r.verdict !== 'error').map((r) => ({
        gateRef: r.gateRef, verdict: r.verdict,
        location: r.evidence.find((e) => e.kind === 'location')?.location,
        outputExcerpt: r.evidence.find((e) => e.kind === 'assertion')?.content,
      })),
      gateErrors: errors.map((e, i) => ({ gateRef: e.gateRef, errorClass: 'gate_fault', outputExcerpt: e.evidence[0]?.content ?? '', retryOrdinal: i })),
      observedVsExpected: failing.flatMap((r) => r.evidence.filter((e) => e.kind === 'reproduction')
        .map((e) => ({ location: e.location ?? '', expected: 'gate pass', observed: e.content }))),
      reproduction: failing.flatMap((r) => r.evidence.filter((e) => e.kind === 'reproduction')
        .map((e) => ({ command: e.content, exitCode: 1, outputExcerpt: e.content }))),
      diffSummary: { filesTouched: h?.filesTouched ?? 0, insertions: h?.insertions ?? 0, deletions: h?.deletions ?? 0 },
      externalFindings: [],
      denials: this.denialsOf(st, attempt.id),
    };
    st.failures.push(rec);
    st.progressHashes.push(hashOf({ failedCriteria: rec.failedCriteria, verdicts: rec.gateResults.map((g) => g.verdict), diff: rec.diffSummary }));
    this.emit('failure.recorded', [st.unit.id, attempt.id], { klass, failedCriteria: rec.failedCriteria });
  }

  private denialsOf(st: UnitState, attemptId: string): FailureRecord['denials'] {
    return st.denialsByAttempt.get(attemptId) ?? [];
  }

  /** Two consecutive identical progress hashes ⇒ escalate, never a third try. */
  noProgress(unitId: string): boolean {
    const st = this.expect(unitId);
    const n = st.progressHashes.length;
    return n >= 2 && st.progressHashes[n - 1] === st.progressHashes[n - 2];
  }

  canRetry(unitId: string): boolean {
    const st = this.expect(unitId);
    if (this.noProgress(unitId)) return false;
    return st.attempts.filter((a) => a.status !== 'superseded').length < st.unit.budget.maxAttempts;
  }

  // -------------------------------------------------------------- approval

  recordApproval(a: Approval): void {
    this.approvals.push(a);
    this.emit('approval.granted', [a.subject.ref], { kind: a.subject.kind, quorum: a.quorum });
  }

  accept(unitId: string, artifactId: string): { accepted: boolean; reason?: string } {
    const st = this.expect(unitId);
    const art = st.artifacts.find((a) => a.id === artifactId);
    if (!art) return { accepted: false, reason: 'unknown artifact' };
    const blockingOk = st.unit.executionSpec.effectiveGates.bindings
      .filter((b) => b.blocking)
      .every((b) => st.gateResults.some((r) => r.gateRef === b.gateRef && r.verdict === 'pass'));
    if (!blockingOk) return { accepted: false, reason: 'blocking gates not all passed' };
    const ap = this.approvals.find((x) =>
      x.subject.kind === 'merge' && x.subject.ref === artifactId &&
      x.subject.contentHash === art.contentHash && x.decision === 'approve' && quorumMet(x));
    if (!ap) return { accepted: false, reason: 'no approval bound to this content hash' };
    st.artifacts[st.artifacts.findIndex((a) => a.id === artifactId)] = { ...art, status: 'accepted' };
    st.status = 'accepted';
    this.emit('workunit.accepted', [unitId, artifactId], {});
    return { accepted: true };
  }

  // -------------------------------------------------------------- recovery

  /**
   * Restart scan. A missing sweep produces work that is STUCK rather than
   * FAILED — invisible, because nothing errors (Note 06 §16.5).
   */
  sweepOrphanedCompleted(faults: Faults = {}): string[] {
    const swept: string[] = [];
    for (const [id, st] of this.units) {
      const last = st.attempts[st.attempts.length - 1];
      if (!last) continue;
      if (last.status === 'completed' && last.producedArtifact === null && st.status === 'running') {
        this.emit('recovery.harvest_resumed', [id, last.id], {});
        this.postExecution(id, last, faults);
        swept.push(id);
      }
    }
    return swept;
  }

  sweepExpiredLeases(): string[] {
    const swept: string[] = [];
    for (const [id, st] of this.units) {
      if (st.lease && Date.parse(st.lease.expiresAt) <= nowMs() && st.status === 'running') {
        this.emit('lease.swept', [id], { epoch: st.epoch });
        swept.push(id);
      }
    }
    return swept;
  }

  sweepStaleReservations(): number {
    let released = 0;
    for (const st of this.units.values()) {
      const terminal = ['accepted', 'rejected', 'escalated', 'exhausted', 'cancelled', 'invalid'];
      if (terminal.includes(st.status) && st.reserved > 0) { this.releaseReservation(st); released += 1; }
    }
    return released;
  }

  private releaseReservation(st: UnitState): void {
    if (st.reserved <= 0) return;
    this.account.reserved -= st.reserved;
    const actual = st.attempts.reduce((a, at) => a + this.d.ledger.spentFor(at.id), 0);
    this.account.spent = actual;
    this.emit('budget.released', [st.unit.id], { released: st.reserved, actual });
    st.reserved = 0;
  }

  // ------------------------------------------------------------ workspaces

  private provisionWorkspace(unitId: string, attemptId: string, baseline: string): string {
    const dir = join(this.d.workspacesRoot, `${unitId}_${attemptId}`);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    mkdirSync(this.d.workspacesRoot, { recursive: true });
    execFileSync('git', ['worktree', 'add', '--detach', dir, baseline], { cwd: this.d.repoRoot, stdio: 'ignore' });
    this.emit('workspace.provisioned', [unitId, attemptId], { baseline });
    return dir;
  }

  disposeWorkspace(ref: string | null): void {
    if (!ref || !existsSync(ref)) return;
    try { execFileSync('git', ['worktree', 'remove', '--force', ref], { cwd: this.d.repoRoot, stdio: 'ignore' }); } catch { /* preserved */ }
  }

  // ---------------------------------------------------------------- helpers

  expect(unitId: string): UnitState {
    const st = this.units.get(unitId);
    if (!st) throw new Error(`unknown work unit ${unitId}`);
    return st;
  }

  private emit(type: string, subject: string[], payload: Record<string, unknown>, causationId: string | null = null, correlationId: string | null = null): void {
    const unitId = subject[0];
    const st = unitId ? this.units.get(unitId) : undefined;
    this.d.events.append(makeEvent(
      this.d.instanceId, type, 'kernel', subject, payload,
      causationId ?? this.lastEventId, correlationId ?? st?.unit.intentRef ?? null,
    ));
    this.lastEventId = this.d.events.all()[this.d.events.all().length - 1]?.eventId ?? null;
  }
  private lastEventId: string | null = null;
}

export const traceStore = new Map<string, string>();

/** Non-`accepted` terminal statuses — matches sweepStaleReservations' terminal set (Note 06 §2.1). */
const TERMINAL_UNIT_STATUSES = new Set<WorkUnitStatus>(['rejected', 'invalid', 'cancelled', 'escalated', 'exhausted']);

function materialKey(u: WorkUnit): string { return `${u.planId}@${u.planVersion}#${u.planNodeId}`; }

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(y.replace(/\*+$/, '')) || y.startsWith(x.replace(/\*+$/, ''))));
}

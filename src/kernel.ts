import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  TaskPlan, PlanNode, WorkUnit, WorkUnitStatus, Attempt, AttemptStatus, Artifact,
  Approval, Escalation, FailureRecord, GateResult, Lease, Money, EffectiveBudget, ContextManifest, DenialRecord,
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
import { quorumMet, validateDispatchApprovals } from './validate.ts';
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
  /** AttemptIds already folded into `account.spent` — releaseReservation() must never re-add one (Note 06 §7). */
  reconciledAttempts: Set<string>;
}

export interface Faults {
  readonly crashAfterExecutorBeforeHarvest?: boolean;
  readonly errorGates?: readonly string[];
  readonly flakyGates?: readonly string[];
  readonly expireLeaseDuringExecution?: boolean;
}

interface PlanState {
  readonly plan: TaskPlan;
  status: TaskPlan['status'];
}

export class Kernel {
  private readonly d: KernelDeps;
  readonly units = new Map<string, UnitState>();
  readonly approvals: Approval[] = [];
  /** Note 06 §11: "Escalation | raised, resolved". No new trigger — records the existing escalation.raised sites. */
  readonly escalations: Escalation[] = [];
  readonly account: BudgetAccount;
  private readonly compiler: ContextCompiler;
  /** Plan-level status projection (Note 06 §2.4), keyed by plan.id@plan.version. Never mutates the input TaskPlan. */
  private readonly plans = new Map<string, PlanState>();

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

    // Register the plan projection once, on its first node's materialisation.
    // The stored `plan` reference is read-only here on; its own status field
    // is never written back to — only this projection's `status` is.
    const planKeyStr = `${plan.id}@${plan.version}`;
    const planRec = this.plans.get(planKeyStr);
    // Caller error, same class as the predecessor-ordering check below
    // (T-D7's precedent): a terminal plan (complete/partial/cancelled) can
    // never gain a new member unit. Checked against the kernel's OWN live
    // projection status, never the caller's possibly-stale input `plan`
    // object, so this is accurate even long after cancelPlan() ran.
    if (planRec && TERMINAL_PLAN_STATUSES.has(planRec.status)) {
      throw new Error(
        `materialise: plan '${planKeyStr}' is already ${planRec.status} — ` +
        `cannot materialise a new node under a terminal plan`,
      );
    }
    if (!planRec) this.plans.set(planKeyStr, { plan, status: plan.status });

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
      denialsByAttempt: new Map(), reconciledAttempts: new Set(),
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

    // Retry/exhaustion decision (Note 06 §2.1). `attempt_failed` stays
    // exactly as it is written by postExecution — this is deliberately
    // deferred, never automatic (T-F10/T-F13 assert `attempt_failed`
    // persists through a single failed runAttempt with no admit() call).
    // The decision fires here, the first time this unit is next admitted.
    // Three distinct outcomes, not two: `no_progress`/`escalate_human` take
    // priority over attempt count and escalate DIRECTLY, bypassing
    // `exhausted` entirely — collapsing them into a single "exhausted"
    // path would misreport why a unit stopped.
    if (st.status === 'attempt_failed') {
      const lastFailure = st.failures[st.failures.length - 1];
      const klass = lastFailure?.klass ?? 'verification_failed';
      const policy = st.unit.executionSpec.onFailure[klass];
      const stalled = this.noProgress(unitId);
      const attemptsRemain = st.attempts.filter((a) => a.status !== 'superseded').length < st.unit.budget.maxAttempts;

      if (stalled || policy === 'escalate_human') {
        st.status = 'escalated';
        this.raiseEscalation(unitId, stalled ? 'no_progress' : klass);
        this.recomputePlanStatus(st.unit);
        return { admitted: false, reason: stalled ? 'no_progress' : 'escalate_human' };
      }
      if (!attemptsRemain) {
        // `exhausted -> escalated`: momentary, design's only trigger is "Always".
        st.status = 'exhausted';
        this.emit('workunit.exhausted', [unitId], {});
        st.status = 'escalated';
        this.raiseEscalation(unitId, 'exhausted');
        this.recomputePlanStatus(st.unit);
        return { admitted: false, reason: 'exhausted' };
      }
      st.status = 'ready';
      this.emit('workunit.ready', [unitId], {});
    }

    // Dependency graph (Note 02 §8, Note 06 §2.1). Any failed upstream
    // dependency blocks the unit regardless of edge kind — the decided
    // resolution to §6's ambiguity. An unresolved (non-terminal) dependency
    // defers admission without touching status, same "defer, never lock"
    // posture as the scope-conflict check below.
    let anyDependencyFailed = false;
    let anyDependencyPending = false;
    let inputHashMismatch = false;
    let failedDependency: { unitId: string; kind: string } | null = null;
    const newPins: WorkUnit['inputs'][number][] = [];
    for (const dep of st.unit.dependsOn) {
      const depState = this.units.get(dep.unitId);
      if (!depState) continue;
      if (depState.status === 'accepted') {
        // Note 02 §9 step 2 / §10: an `artifact`-edge predecessor pins its
        // accepted artifact's content hash into this unit's `inputs`, the
        // first time admit() observes it accepted — materialise() cannot do
        // this (nodes are materialised before predecessors run, see T-D8),
        // so admission is the correct, and only, point this is knowable.
        // `as` and `segments` have no authored source anywhere in the plan
        // schema (neither PlanNode nor a plan edge declares a binding name
        // or segment scope) — `as` defaults to the predecessor's own
        // planNodeId (already-present data) and `segments` to `[]`
        // (requests nothing), the smallest non-fabricated choice, not a
        // stand-in for a future recipe-binding declaration.
        if (dep.kind === 'artifact') {
          const acceptedArtifact = depState.artifacts.find((a) => a.status === 'accepted');
          if (acceptedArtifact) {
            const existing = st.unit.inputs.find((i) => i.artifactId === acceptedArtifact.id);
            if (existing) {
              // §9 step 3: pinned hash must still match the stored artifact.
              // Unreachable via normal flow today — an accepted artifact
              // never changes and an accepted unit never attempts again —
              // but checked explicitly rather than assumed, per §10 rule 2.
              if (existing.contentHash !== acceptedArtifact.contentHash) inputHashMismatch = true;
            } else {
              newPins.push({
                artifactId: acceptedArtifact.id, contentHash: acceptedArtifact.contentHash,
                as: depState.unit.planNodeId, segments: [],
              });
            }
          }
        }
        continue;
      }
      if (TERMINAL_UNIT_STATUSES.has(depState.status)) { anyDependencyFailed = true; failedDependency = dep; }
      else anyDependencyPending = true;
    }
    // Pins accumulate progressively across admit() calls and are immutable
    // once set (never reassigned above, only appended to) — applied
    // regardless of which branch below fires, so a later admit() call sees
    // every predecessor pinned as soon as each individually becomes accepted.
    if (newPins.length > 0) st.unit = { ...st.unit, inputs: [...st.unit.inputs, ...newPins] };
    if (inputHashMismatch) return { admitted: false, reason: 'input_hash_mismatch' };
    if (anyDependencyFailed) {
      // The entry guard above already limits st.status to validated/ready/
      // attempt_failed here, so this is always a fresh transition into blocked.
      st.status = 'blocked';
      this.emit('workunit.blocked', [unitId], { failedDependency: failedDependency!.unitId, kind: failedDependency!.kind });
      this.recomputePlanStatus(st.unit);
      return { admitted: false, reason: 'dependency_failed' };
    }
    if (anyDependencyPending) return { admitted: false, reason: 'dependency_unmet' };

    // Blocking pre-dispatch approvals (Note 02 §9 / Note 06 §2.1 — the other
    // half of `ready`'s trigger, alongside dependencies). Reuses the C12
    // validator (validate.ts) unchanged; defers, never locks, same posture
    // as every other check in this function.
    const needsPreDispatchApproval = st.unit.approvalsRequired.some((a) => a.blocking && a.kind === 'pre_dispatch');
    if (needsPreDispatchApproval) {
      const planRec = this.plans.get(`${st.unit.planId}@${st.unit.planVersion}`);
      const planContentHash = planRec ? hashOf(planRec.plan) : '';
      if (!validateDispatchApprovals(st.unit, planContentHash, this.approvals).ok) {
        return { admitted: false, reason: 'approval_missing' };
      }
    }

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
    this.markPlanRunning(st.unit);
    this.emit('attempt.started', [unitId, attemptId], { ordinal, epoch, specHash: spec.hash });

    const result = runExecutor(
      { attemptId, workUnitId: unitId, executionSpec: spec, renderedContext: rendered, contextManifestRef: manifest.id, capabilityToken: token, workspaceRef: ws, deadline },
      { tools, models, executionCeiling: st.unit.budget.execution.costCeiling },
    );

    for (const r of tools.records) this.emit(r.outcome === 'denied' ? 'tool.denied' : 'tool.invoked', [unitId, attemptId], { ...r });
    // responseShape is structured forensic evidence (never raw model text —
    // see ModelResponseShape, types.ts) of what a turn's parse produced, so a
    // `completed` attempt with zero tool calls is durably distinguishable in
    // the event trail as `done` / `no_action` / `malformed` after the fact.
    // Keyed by seq, not position: a budget_halt/error record never has one.
    const shapeBySeq = new Map(result.responseShapes.map((s) => [s.seq, s.shape]));
    for (const r of models.records) {
      const shape = shapeBySeq.get(r.seq);
      this.emit('model.served', [unitId, attemptId], shape ? { ...r, responseShape: shape } : { ...r });
    }
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
    try {
      this.postExecutionInner(unitId, st, attempt, faults);
    } finally {
      // Recompute regardless of which exit path was taken above — cheap and
      // idempotent (recomputePlanStatus no-ops once complete/partial).
      this.recomputePlanStatus(st.unit);
    }
  }

  private postExecutionInner(unitId: string, st: UnitState, attempt: Attempt, faults: Faults): void {
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
      this.raiseEscalation(unitId, 'capability_denied');
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
      this.raiseEscalation(unitId, 'indeterminate', { gate: gr.indeterminate.gateRef });
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

  // ----------------------------------------------------------- escalation

  /** Records the existing escalation.raised sites as a real Escalation, not just an event. No new trigger. */
  private raiseEscalation(unitId: string, klass: string, extra: Record<string, unknown> = {}): void {
    const id = nextId('esc');
    const rec: Escalation = { id, unitId, klass, raisedAt: now(), resolvedAt: null, resolution: null };
    this.escalations.push(rec);
    this.emit('escalation.raised', [unitId], { klass, ...extra });
  }

  /** Human-only by convention, same as recordApproval. Idempotent: a second call on an already-resolved escalation is refused, not silently re-applied. */
  resolveEscalation(id: string, resolution: string): { resolved: boolean; reason?: string } {
    const idx = this.escalations.findIndex((e) => e.id === id);
    if (idx < 0) return { resolved: false, reason: 'unknown escalation' };
    const esc = this.escalations[idx]!;
    if (esc.resolvedAt) return { resolved: false, reason: 'already resolved' };
    this.escalations[idx] = { ...esc, resolvedAt: now(), resolution };
    this.emit('escalation.resolved', [esc.unitId], { escalationId: id, resolution });
    return { resolved: true };
  }

  // -------------------------------------------------------------- approval

  recordApproval(a: Approval): void {
    this.approvals.push(a);
    this.emit('approval.granted', [a.subject.ref], { kind: a.subject.kind, quorum: a.quorum });
  }

  /**
   * The blocking-gates check below existed as accept()'s only correctness
   * anchor; it is not sufficient on its own, because gateResults are never
   * cleared by cancel()/reject() — a unit cancelled AFTER its gates already
   * passed still has blockingOk === true. The explicit status guard closes
   * that gap. It runs AFTER the blocking-gates check, not before (unlike
   * reject()'s ordering), because T-J4 asserts a unit in `attempt_failed`
   * is refused with a "blocking gates" reason specifically — putting the
   * status guard first would return a different reason and break that
   * existing, unmodified test. The predicate itself still matches reject()'s
   * exactly (`status !== 'awaiting_approval'`).
   */
  accept(unitId: string, artifactId: string): { accepted: boolean; reason?: string } {
    const st = this.expect(unitId);
    const art = st.artifacts.find((a) => a.id === artifactId);
    if (!art) return { accepted: false, reason: 'unknown artifact' };
    const blockingOk = st.unit.executionSpec.effectiveGates.bindings
      .filter((b) => b.blocking)
      .every((b) => st.gateResults.some((r) => r.gateRef === b.gateRef && r.verdict === 'pass'));
    if (!blockingOk) return { accepted: false, reason: 'blocking gates not all passed' };
    if (st.status !== 'awaiting_approval') return { accepted: false, reason: `status ${st.status}` };
    const ap = this.approvals.find((x) =>
      x.subject.kind === 'merge' && x.subject.ref === artifactId &&
      x.subject.contentHash === art.contentHash && x.decision === 'approve' && quorumMet(x));
    if (!ap) return { accepted: false, reason: 'no approval bound to this content hash' };
    st.artifacts[st.artifacts.findIndex((a) => a.id === artifactId)] = { ...art, status: 'accepted' };
    st.status = 'accepted';
    this.emit('workunit.accepted', [unitId, artifactId], {});
    this.recomputePlanStatus(st.unit);
    return { accepted: true };
  }

  /**
   * `awaiting_approval -> rejected`, human only (Note 06 §2.1). Unlike
   * accept(), there is no gate-passing check to anchor correctness on, so
   * the source-status guard is explicit here. The artifact was EVALUATED
   * and failed — `rejected`, never `abandoned` (Note 02 §13's distinction).
   */
  reject(unitId: string, artifactId: string): { rejected: boolean; reason?: string } {
    const st = this.expect(unitId);
    if (st.status !== 'awaiting_approval') return { rejected: false, reason: `status ${st.status}` };
    const art = st.artifacts.find((a) => a.id === artifactId);
    if (!art) return { rejected: false, reason: 'unknown artifact' };
    const rj = this.approvals.find((x) =>
      x.subject.kind === 'merge' && x.subject.ref === artifactId &&
      x.subject.contentHash === art.contentHash && x.decision === 'reject' && quorumMet(x));
    if (!rj) return { rejected: false, reason: 'no reject decision bound to this content hash' };
    st.artifacts[st.artifacts.findIndex((a) => a.id === artifactId)] = { ...art, status: 'rejected' };
    st.status = 'rejected';
    this.emit('workunit.rejected', [unitId, artifactId], {});
    this.recomputePlanStatus(st.unit);
    return { rejected: true };
  }

  /**
   * *Any non-terminal -> cancelled*, human, direct call (Note 06 §2.1; the
   * "kernel on parent-plan failure" cascade is a separate, larger slice —
   * not implemented here). `running`/`verifying` are excluded because they
   * are never externally observable: runAttempt() is a single synchronous
   * call with no yield point, so nothing can call cancel() while a unit is
   * genuinely mid-attempt — by the time any caller regains control, the
   * unit has already left that status. No reservation/workspace cleanup is
   * needed: every reachable status has already released its reservation
   * (postExecution does so on every exit path) and workspaces are already
   * preserved by default (T-G5) — cancellation changes no mechanism there,
   * only the terminal status. Descendant-blocking and plan-aggregation to
   * `partial` need no new code either: `admit()` and recomputePlanStatus
   * already treat `cancelled` as a terminal-failure status (added in the
   * DAG slice, before anything could produce it).
   */
  cancel(unitId: string, reason: string): { cancelled: boolean; reason?: string } {
    const st = this.expect(unitId);
    if (!CANCELLABLE_STATUSES.has(st.status)) return { cancelled: false, reason: `status ${st.status}` };
    for (let i = 0; i < st.artifacts.length; i++) {
      const a = st.artifacts[i]!;
      // Cut short, never evaluated: `abandoned`, never `rejected` (Note 02 §13).
      if (a.status === 'draft' || a.status === 'verified') st.artifacts[i] = { ...a, status: 'abandoned' };
    }
    st.status = 'cancelled';
    this.emit('workunit.cancelled', [unitId], { reason });
    this.recomputePlanStatus(st.unit);
    return { cancelled: true };
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
    // Note 06 §7: `instance_spent += actual`. The account is instance-scoped
    // (its cap is `perDayCap`), so a unit's terminal reconciliation ADDS its
    // spend; assigning would erase every prior unit's, and `admit()`'s
    // headroom check reads this field — under-counting there is an overspend,
    // the one direction `fail_closed` forbids.
    //
    // `actual` must be summed only over attempts NOT already folded into
    // `account.spent` — a retried unit calls releaseReservation() once per
    // attempt (attempt_failed releases and re-reserves on retry), so summing
    // st.attempts unconditionally re-adds every prior attempt's spend on
    // each subsequent release, over-counting the account by their sum. The
    // `reconciledAttempts` set makes each attempt contribute exactly once,
    // independent of how many times release fires for this unit.
    const unreconciled = st.attempts.filter((at) => !st.reconciledAttempts.has(at.id));
    const actual = unreconciled.reduce((a, at) => a + this.d.ledger.spentFor(at.id), 0);
    for (const at of unreconciled) st.reconciledAttempts.add(at.id);
    this.account.spent += actual;
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

  // ------------------------------------------------------------------ plan

  /** Public projection read — Note 06 §2.4. Returns undefined if the plan was never materialised. */
  planStatus(planId: string, version: string): TaskPlan['status'] | undefined {
    return this.plans.get(`${planId}@${version}`)?.status;
  }

  /**
   * `approved | running -> cancelled`, human, direct call (design/06 §2.1
   * line 76's "any non-terminal -> cancelled", specialised at plan level by
   * §2.4 line 111's `running -> cancelled`; `approved` is included because
   * the plan projection legitimately sits there between materialisation and
   * first dispatch — nothing in this kernel ever registers a projection at
   * `draft` (slice01.ts always authors `approved`), so `draft` is refused
   * the same as any other non-{approved,running} status, not specially
   * handled. The "kernel on parent-plan failure" half of that design line
   * is a separate, unimplemented trigger — this is only the human path.
   *
   * Takes `planId` + `version` — same convention as planStatus() — rather
   * than resolving a bare id to a "current" version. design/02 §8 names
   * `superseded_by` as the intended forward-pointer for that resolution,
   * but it is not a field on `TaskPlan` in types.ts (only `supersedes`
   * exists, typed as a bare string, unresolved anywhere in this codebase,
   * and exercised by zero tests). Inventing a resolution rule here would
   * mean guessing at an architecture decision that has not actually been
   * made; the caller supplying the version it already has avoids that.
   *
   * Cascades through the EXISTING cancel() unchanged, per member node.
   * dependsOn edges are populated solely from this plan's own `edges`
   * (materialise()), so every descendant of a cancelled unit is itself a
   * member node of this same plan and gets cancelled directly in this same
   * pass — no separate blocked-walk is needed or added. Already-terminal
   * members (accepted, rejected, escalated, already cancelled) are left
   * untouched because cancel() itself refuses them via CANCELLABLE_STATUSES,
   * unmodified here.
   *
   * The projection is set to `cancelled` BEFORE the cascade so that each
   * member cancel()'s own internal recomputePlanStatus() call sees an
   * already-terminal plan and no-ops (idempotency guard fixed alongside
   * this to include `cancelled`) rather than racing to compute
   * complete/partial mid-cascade.
   */
  cancelPlan(planId: string, version: string, reason: string): { cancelled: boolean; reason?: string } {
    const rec = this.plans.get(`${planId}@${version}`);
    if (!rec) return { cancelled: false, reason: 'unknown plan' };
    if (rec.status !== 'approved' && rec.status !== 'running') {
      return { cancelled: false, reason: `status ${rec.status}` };
    }
    rec.status = 'cancelled';
    for (const node of rec.plan.nodes) {
      const nodeKey = `${rec.plan.id}@${rec.plan.version}#${node.nodeId}`;
      const member = [...this.units.values()].find((u) => materialKey(u.unit) === nodeKey);
      if (!member) continue;
      if (CANCELLABLE_STATUSES.has(member.status)) this.cancel(member.unit.id, reason);
    }
    this.emit('plan.cancelled', [rec.plan.id], { version: rec.plan.version }, null, rec.plan.intentRef);
    return { cancelled: true };
  }

  /** `approved -> running`: "First node dispatched" — the first unit to actually reach `running`. */
  private markPlanRunning(unit: WorkUnit): void {
    const rec = this.plans.get(`${unit.planId}@${unit.planVersion}`);
    if (!rec || rec.status !== 'approved') return; // idempotent: fires once
    rec.status = 'running';
    this.emit('plan.running', [unit.planId], { version: unit.planVersion }, null, unit.intentRef);
  }

  /**
   * `running -> complete` (all nodes `accepted`) or `running -> partial` (all
   * nodes terminal, >=1 not `accepted`) — Note 06 §2.4. A node's failure does
   * not fail the plan (Note 02 §8 rule 5); independent branches are simply
   * accounted for in `partial`. Safe to call redundantly — idempotent once
   * the plan has resolved to `complete`/`partial`.
   */
  private recomputePlanStatus(unit: WorkUnit): void {
    const rec = this.plans.get(`${unit.planId}@${unit.planVersion}`);
    // `cancelled` is terminal same as complete/partial — added alongside
    // cancelPlan() so a mid-cascade member cancel() (which calls this
    // internally) can never overwrite a plan cancellation's own projection.
    if (!rec || rec.status === 'complete' || rec.status === 'partial' || rec.status === 'cancelled') return;

    let allTerminal = true;
    let allAccepted = true;
    for (const node of rec.plan.nodes) {
      const nodeKey = `${rec.plan.id}@${rec.plan.version}#${node.nodeId}`;
      const member = [...this.units.values()].find((u) => materialKey(u.unit) === nodeKey);
      if (!member || (member.status !== 'accepted' && !TERMINAL_UNIT_STATUSES.has(member.status))) {
        allTerminal = false;
        break;
      }
      if (member.status !== 'accepted') allAccepted = false;
    }
    if (!allTerminal) return;

    rec.status = allAccepted ? 'complete' : 'partial';
    this.emit(`plan.${rec.status}`, [unit.planId], { version: unit.planVersion }, null, unit.intentRef);
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

/**
 * Non-`accepted` terminal-or-terminal-like statuses, for dependency and plan
 * aggregation purposes. Includes `blocked`: design/06 §2.1's own "Terminal:"
 * list omits it, but no outgoing transition exists for it anywhere in that
 * table, and Note 02 §8 rule 3 requires failure to propagate transitively
 * (n1 fails -> n2 blocked -> n3 blocked). Without `blocked` here, a chain
 * deeper than two nodes would stall a downstream unit in `validated` forever
 * and a plan containing it could never reach `partial`. Deliberately NOT the
 * same set sweepStaleReservations uses inline (a blocked unit never held a
 * reservation, so that set has no reason to include it).
 */
const TERMINAL_UNIT_STATUSES = new Set<WorkUnitStatus>(['rejected', 'invalid', 'cancelled', 'escalated', 'exhausted', 'blocked']);

/**
 * Statuses cancel() actually accepts. Not literally "any non-terminal"
 * (design/06 §2.1's phrase): `running`/`verifying` are excluded as
 * unreachable (see cancel()'s own comment), and `blocked` is included per
 * its own absence from the design's "Terminal:" list (a prior finding,
 * treated here as the resolved reading, not re-litigated).
 */
const CANCELLABLE_STATUSES = new Set<WorkUnitStatus>(['validated', 'ready', 'blocked', 'attempt_failed', 'awaiting_approval']);

/** The three terminal values of `TaskPlan['status']` — materialise() refuses to add a member unit to a plan in any of these. */
const TERMINAL_PLAN_STATUSES = new Set<TaskPlan['status']>(['complete', 'partial', 'cancelled']);

function materialKey(u: WorkUnit): string { return `${u.planId}@${u.planVersion}#${u.planNodeId}`; }

function overlaps(a: readonly string[], b: readonly string[]): boolean {
  return a.some((x) => b.some((y) => x === y || x.startsWith(y.replace(/\*+$/, '')) || y.startsWith(x.replace(/\*+$/, ''))));
}

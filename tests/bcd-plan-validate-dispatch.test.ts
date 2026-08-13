import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, makePlan, POLICY, planHash, FIXING_SCRIPT, approvalFor } from '../src/slice01.ts';
import { validatePlan, validateDispatchApprovals } from '../src/validate.ts';
import type { ValidationEnv } from '../src/validate.ts';
import type { TaskPlan, PlanNode } from '../src/types.ts';
import { hashOf } from '../src/util.ts';

function env(w: ReturnType<typeof makeWorld>, over: Partial<ValidationEnv> = {}): ValidationEnv {
  return {
    registry: w.registry, policy: POLICY,
    intents: new Set(['int_001']),
    memoryObjectiveIds: new Set(['mem_obj_1']),
    artifacts: new Map(), approvals: [], instanceRemaining: 200,
    ...over,
  };
}
function node(p: TaskPlan): PlanNode { return p.nodes[0]!; }
function rejects(r: { ok: boolean; issues: readonly { rule: string }[] }, rule: string): void {
  assert.equal(r.ok, false, `expected rejection under ${rule}`);
  assert.ok(r.issues.some((i) => i.rule === rule), `expected rule ${rule}, got ${r.issues.map((i) => i.rule).join(',')}`);
}

// ============================================================ B. Plan

test('T-B1 intent resolves and lineage is traceable', () => {
  const w = makeWorld();
  assert.equal(w.plan.intentRef, 'int_001');
  const unit = w.kernel.materialise(w.plan, node(w.plan), w.baseline);
  assert.equal(unit.intentRef, 'int_001');
  const evs = w.events.bySubject(unit.id);
  assert.ok(evs.every((e) => e.correlationId === 'int_001'), 'every unit event correlates to the intent');
});

test('T-B2 the plan is a real hashed artifact and validates', () => {
  const w = makeWorld();
  const r = validatePlan(w.plan, env(w));
  assert.ok(r.ok, JSON.stringify(r.issues));
  assert.equal(typeof planHash(w.plan), 'string');
  assert.notEqual(planHash(w.plan), planHash({ ...w.plan, version: '1.0.1' }));
});

test('T-B3 node materialisation is idempotent under (plan@version, nodeId)', () => {
  const w = makeWorld();
  const a = w.kernel.materialise(w.plan, node(w.plan), w.baseline);
  const b = w.kernel.materialise(w.plan, node(w.plan), w.baseline);
  assert.equal(a.id, b.id, 'second call is a no-op');
  assert.equal(w.kernel.units.size, 1);
});

// ======================================================= C. Validation
// Each is a REJECTION test. Global condition: zero model calls are spent.

test('T-C1 cyclic authored graph is rejected', () => {
  const w = makeWorld();
  const n1 = node(w.plan);
  const plan: TaskPlan = { ...w.plan, nodes: [n1, { ...n1, nodeId: 'n2' }], edges: [{ from: 'n1', to: 'n2', kind: 'artifact' }, { from: 'n2', to: 'n1', kind: 'artifact' }] };
  rejects(validatePlan(plan, env(w)), 'C1');
});

test('T-C2 an authored `resource` edge is rejected', () => {
  const w = makeWorld();
  const n1 = node(w.plan);
  const plan = { ...w.plan, nodes: [n1, { ...n1, nodeId: 'n2' }], edges: [{ from: 'n1', to: 'n2', kind: 'resource' as unknown as 'artifact' }] };
  rejects(validatePlan(plan, env(w)), 'C2');
});

test('T-C3 an unadmitted role is rejected', () => {
  const w = makeWorld();
  const plan = { ...w.plan, nodes: [{ ...node(w.plan), roleRef: 'architect@1.0.0' }] };
  rejects(validatePlan(plan, env(w)), 'C3');
});

test('T-C4 a role that is a gate\'s executing role may never be a plan node', () => {
  const w = makeWorld();
  // Synthesise a verification role by registering a gate that names one.
  const reg = w.registry as unknown as { allGates: () => unknown[] };
  void reg;
  const fake = { ...w.registry } as unknown as { verificationRoles: () => Set<string> };
  fake.verificationRoles = () => new Set(['implementer']);
  const e = env(w, { registry: Object.assign(Object.create(Object.getPrototypeOf(w.registry)), w.registry, { verificationRoles: () => new Set(['implementer']) }) as ValidationEnv['registry'] });
  rejects(validatePlan(w.plan, e), 'C4');
});

test('T-C5 a node declaring class: verification is rejected', () => {
  const w = makeWorld();
  const plan = { ...w.plan, nodes: [{ ...node(w.plan), klass: 'verification' as unknown as PlanNode['klass'] }] };
  rejects(validatePlan(plan, env(w)), 'C5');
});

test('T-C6 expected_output must equal the role\'s produces', () => {
  const w = makeWorld();
  const plan = { ...w.plan, nodes: [{ ...node(w.plan), expectedOutput: 'ArchitectureDecision' }] };
  rejects(validatePlan(plan, env(w)), 'C6');
});

test('T-C7 criterion class must match the gate\'s criterion_class', () => {
  const w = makeWorld();
  const n = node(w.plan);
  const plan = { ...w.plan, nodes: [{ ...n, acceptanceCriteria: [{ ...n.acceptanceCriteria[0]!, klass: 'C2' as const }] }] };
  rejects(validatePlan(plan, env(w)), 'C7');
});

test('T-C7b an unresolvable gate_ref is rejected', () => {
  const w = makeWorld();
  const n = node(w.plan);
  const plan = { ...w.plan, nodes: [{ ...n, acceptanceCriteria: [{ ...n.acceptanceCriteria[0]!, check: { gateRef: 'no.such.gate@1.0.0' } }] }] };
  rejects(validatePlan(plan, env(w)), 'C7');
});

test('T-C8 a node with no C0/C1 criterion is rejected', () => {
  const w = makeWorld();
  const n = node(w.plan);
  const c3only = { id: 'x', statement: 'human judgement', klass: 'C3' as const, check: { gateRef: 'approval.merge@1.0.0' }, blocking: true };
  const plan = { ...w.plan, nodes: [{ ...n, acceptanceCriteria: [c3only] }] };
  rejects(validatePlan(plan, env(w)), 'C8');
});

test('T-C9 a gate requesting a private segment is rejected', () => {
  const w = makeWorld();
  const g = w.registry.getGate('deps.unchanged@1.0.0');
  const patched = Object.assign(Object.create(Object.getPrototypeOf(w.registry)), w.registry, {
    getGate: (ref: string) => ref.startsWith('deps.unchanged') ? { ...g, requiresSegments: ['diff', 'reasoning_trace'] } : w.registry.getGate(ref),
    hasGate: (ref: string) => w.registry.hasGate(ref),
  });
  rejects(validatePlan(w.plan, env(w, { registry: patched as ValidationEnv['registry'] })), 'C9');
});

test('T-C10 intent_ref may never be a MemoryRecord of kind objective', () => {
  const w = makeWorld();
  const plan = { ...w.plan, intentRef: 'mem_obj_1' };
  rejects(validatePlan(plan, env(w)), 'C10');
});

test('T-C10b an unresolvable intent_ref is rejected', () => {
  const w = makeWorld();
  rejects(validatePlan({ ...w.plan, intentRef: 'int_missing' }, env(w)), 'C10');
});

test('T-C11 a plan exceeding instance headroom is rejected', () => {
  const w = makeWorld();
  rejects(validatePlan(w.plan, env(w, { instanceRemaining: 1 })), 'C11');
});

test('T-C12 a blocking pre-dispatch approval must be bound to this content hash', () => {
  const w = makeWorld();
  const n = { ...node(w.plan), approvalsRequired: [{ kind: 'pre_dispatch', subject: 'plan', blocking: true }] };
  const plan = { ...w.plan, nodes: [n] };
  const unit = w.kernel.materialise(plan, n, w.baseline);
  const h = planHash(plan);

  assert.equal(validateDispatchApprovals(unit, h, []).ok, false, 'absent approval blocks dispatch');

  const good = {
    id: 'a1', subject: { kind: 'plan', ref: plan.id, contentHash: h },
    decision: 'approve' as const, quorum: '1 of 1', approvers: ['human:founder'],
    signatures: [{ approver: 'human:founder', decidedAt: 'now', contentHash: h }],
    blocking: true, decidedAt: 'now', scope: { reuse: 'one_time' as const, expiresAt: null },
  };
  assert.equal(validateDispatchApprovals(unit, h, [good]).ok, true);
  // Any content change voids it.
  assert.equal(validateDispatchApprovals(unit, hashOf({ ...plan, version: '9' }), [good]).ok, false);
});

test('T-C-global every validation rejection costs zero model calls', () => {
  const w = makeWorld();
  const bad = { ...w.plan, intentRef: 'int_missing' };
  validatePlan(bad, env(w));
  assert.equal(w.ledger.total(), 0, 'validation is deterministic and pre-dispatch');
  assert.equal(w.events.byType('model.served').length, 0);
});

// ========================================================= D. Dispatch

test('T-D1 ResolvedExecutionSpec is flattened, hashed, and recomputes identically', () => {
  const w = makeWorld();
  const u1 = w.kernel.materialise(w.plan, node(w.plan), w.baseline);
  const w2 = makeWorld();
  const u2 = w2.kernel.materialise(w2.plan, node(w2.plan), w2.baseline);
  assert.equal(u1.executionSpec.hash, u2.executionSpec.hash, 'resolution is deterministic');
  assert.ok(u1.executionSpec.effectiveCapabilities.resolvedFrom.length >= 2, 'derivation is preserved for audit');
  assert.ok(u1.executionSpec.effectiveGates.bindings.length >= 6);
  assert.equal(u1.executionSpec.effectiveBudget.verification.cost, 0, 'verification allocation is separate and zero in slice 01');
});

test('T-D3 lease is compare-and-set: the second scheduler does not dispatch', () => {
  const w = makeWorld();
  const u = w.kernel.materialise(w.plan, node(w.plan), w.baseline);
  const first = w.kernel.acquireLease(u.id, 'sched-1');
  const second = w.kernel.acquireLease(u.id, 'sched-2');
  assert.ok(first, 'first scheduler acquires');
  assert.equal(second, null, 'second scheduler is refused');
  assert.equal(first!.epoch, 1);
});

test('T-D4 admission control defers on scope conflict rather than locking', () => {
  const w = makeWorld();
  const n1 = node(w.plan);
  const u1 = w.kernel.materialise(w.plan, n1, w.baseline);
  const plan2: TaskPlan = { ...w.plan, id: 'plan_002', nodes: [{ ...n1, nodeId: 'n2' }] };
  const u2 = w.kernel.materialise(plan2, plan2.nodes[0]!, w.baseline);

  assert.equal(w.kernel.admit(u1.id).admitted, true);
  w.kernel.expect(u1.id).status = 'running';
  const r = w.kernel.admit(u2.id);
  assert.equal(r.admitted, false);
  assert.ok(r.reason === 'scope_conflict' || r.reason === 'max_running_units');
  assert.equal(w.kernel.expect(u2.id).status, 'validated', 'work waits; it does not deadlock');
});

// -------------------------------------------------- D5-D7: dependency graph
// A real two-node plan, exercised for the first time (Note 02 §8, Note 06
// §2.1) — Slice 01 itself never authors an edge. Ordering and artifact edges
// are deliberately tested identically: a failed upstream dependency blocks
// regardless of edge kind (resolved ambiguity from the planning pass).

for (const kind of ['ordering', 'artifact'] as const) {
  test(`T-D5 (${kind}) admission defers until the dependency is accepted, then admits`, () => {
    const w = makeWorld();
    const n1 = { ...node(w.plan), nodeId: 'n1' };
    const n2 = { ...node(w.plan), nodeId: 'n2' };
    const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind }] };
    const u1 = w.kernel.materialise(plan, n1, w.baseline);
    const u2 = w.kernel.materialise(plan, n2, w.baseline);
    assert.deepEqual(u2.dependsOn, [{ unitId: u1.id, kind }], 'dependsOn is populated from the authored edge');

    const deferred = w.kernel.admit(u2.id);
    assert.equal(deferred.admitted, false);
    assert.equal(deferred.reason, 'dependency_unmet');
    assert.equal(w.kernel.expect(u2.id).status, 'validated', 'deferred, not locked, not blocked');

    w.kernel.expect(u1.id).status = 'accepted';
    const r = w.kernel.admit(u2.id);
    assert.equal(r.admitted, true);
    assert.equal(w.kernel.expect(u2.id).status, 'ready', 'validated -> ready once dependencies and admission are satisfied (Note 06 §2.1)');
  });
}

test('T-D6 a failed upstream dependency blocks the successor regardless of edge kind', () => {
  const w = makeWorld();
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  const u2 = w.kernel.materialise(plan, n2, w.baseline);

  w.kernel.expect(u1.id).status = 'exhausted'; // terminal, not accepted
  const r = w.kernel.admit(u2.id);
  assert.equal(r.admitted, false);
  assert.equal(r.reason, 'dependency_failed');
  assert.equal(w.kernel.expect(u2.id).status, 'blocked', 'blocked, never attempt_failed (Note 02 §2)');
  assert.equal(w.kernel.expect(u2.id).failures.length, 0, 'a blocked unit did nothing wrong — no FailureRecord');
  assert.equal(w.kernel.expect(u2.id).attempts.length, 0, 'no attempt is consumed');
  assert.ok(w.events.byType('workunit.blocked').length >= 1);
});

test('T-D7 materialising a dependent node before its predecessor is a caller error, not a silent gap', () => {
  const w = makeWorld();
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }] };
  assert.throws(() => w.kernel.materialise(plan, n2, w.baseline), /not yet materialised/);
});

test('T-D8 a dependency-satisfied unit is driven through the full post-admission lifecycle to accepted', () => {
  // Closes the gap the prior verification pass found: T-D5 proved admit()'s
  // decision in isolation only. This drives the dependent unit through the
  // SAME acquireLease -> runAttempt -> harvest -> gates -> approval -> accept
  // machinery every other passing-attempt test already uses (fullRun()'s
  // pattern in jklm-approval-replay-budget.test.ts, T-J1), with no new helper.
  const w = makeWorld({ script: FIXING_SCRIPT });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  const u2 = w.kernel.materialise(plan, n2, w.baseline);

  // n1 in the terminal state a satisfied dependency requires (T-D5's own pattern).
  w.kernel.expect(u1.id).status = 'accepted';

  const admission = w.kernel.admit(u2.id);
  assert.equal(admission.admitted, true);
  assert.equal(w.kernel.expect(u2.id).status, 'ready', 'validated -> ready once the dependency is satisfied');

  // Existing lifecycle, unmodified: acquireLease -> runAttempt -> harvest -> gates.
  w.kernel.acquireLease(u2.id, 's1');
  w.kernel.runAttempt(u2.id, FIXING_SCRIPT);
  const st = w.kernel.expect(u2.id);
  assert.equal(st.status, 'awaiting_approval', 'ready -> running -> verifying -> awaiting_approval, same as any other unit');

  // Existing merge-approval -> accept lifecycle, unmodified (T-J1's pattern).
  const art = st.artifacts[st.artifacts.length - 1]!;
  w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));
  const accepted = w.kernel.accept(u2.id, art.id);
  assert.equal(accepted.accepted, true, accepted.reason);
  assert.equal(w.kernel.expect(u2.id).status, 'accepted', 'the dependency-satisfied unit reaches the normal successful terminal state');

  assert.equal(st.failures.length, 0, 'no dependency-related or any other failure occurred');
  assert.equal(w.events.byType('workunit.blocked').length, 0, 'never blocked at any point in this run');
});

// ----------------------------------------- Plan-level status aggregation
// Note 06 §2.4: approved -> running -> complete/partial. Kernel-owned
// projection, keyed by plan.id@plan.version; the input TaskPlan is never
// mutated (asserted implicitly — `plan.status` below is never read again
// after construction, only `w.kernel.planStatus(...)` is).

test('T-D9 an incomplete plan is neither complete nor partial while a node remains unresolved', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  w.kernel.materialise(plan, n2, w.baseline);
  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'approved', 'nothing dispatched yet');

  w.kernel.acquireLease(u1.id, 's1');
  w.kernel.runAttempt(u1.id, FIXING_SCRIPT);
  const st1 = w.kernel.expect(u1.id);
  assert.equal(st1.status, 'awaiting_approval');
  const art1 = st1.artifacts[st1.artifacts.length - 1]!;
  w.kernel.recordApproval(approvalFor('merge', art1.id, art1.contentHash));
  w.kernel.accept(u1.id, art1.id);
  assert.equal(w.kernel.expect(u1.id).status, 'accepted');

  // n2 is still untouched (never even admitted) — the plan cannot resolve.
  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'running');
});

test('T-D10 a plan with every node accepted reaches complete, with correct event evidence', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2], edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  const u2 = w.kernel.materialise(plan, n2, w.baseline);

  const driveToAccepted = (u: typeof u1): void => {
    w.kernel.acquireLease(u.id, 's1');
    w.kernel.runAttempt(u.id, FIXING_SCRIPT);
    const st = w.kernel.expect(u.id);
    const art = st.artifacts[st.artifacts.length - 1]!;
    w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));
    w.kernel.accept(u.id, art.id);
  };

  driveToAccepted(u1);
  assert.equal(w.kernel.expect(u1.id).status, 'accepted');
  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'running', 'still waiting on n2');

  assert.equal(w.kernel.admit(u2.id).admitted, true, 'n1 accepted satisfies the ordering dependency');
  driveToAccepted(u2);
  assert.equal(w.kernel.expect(u2.id).status, 'accepted');
  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'complete');

  const evs = w.events.byType('plan.complete');
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.correlationId, plan.intentRef, 'plan events correlate to the originating intent, like unit events');
  assert.equal((evs[0]!.payload as { version: string }).version, plan.version);
});

test('T-D11 a plan with mixed terminal outcomes reaches partial', () => {
  // n2 genuinely fails via the existing denial-budget escalation path
  // (T-F4's mechanism) rather than a direct status assignment, so this test
  // proves aggregation against a REAL terminal-failure transition too.
  const spam = (_p: string, t: number): string => (t <= 6 ? 'CALL net.fetch https://x.invalid/a {"path":"a"}' : 'DONE');
  const w = makeWorld({ script: spam });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1, n2] }; // independent nodes, no edge needed
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  const u2 = w.kernel.materialise(plan, n2, w.baseline);

  w.kernel.expect(u1.id).status = 'accepted'; // not the focus of this test

  w.kernel.acquireLease(u2.id, 's1');
  w.kernel.runAttempt(u2.id, spam);
  assert.equal(w.kernel.expect(u2.id).status, 'escalated');

  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'partial');
  assert.ok(w.events.byType('plan.partial').length >= 1);
});

test('T-D12 blocking propagates transitively through a 3-node chain, and the plan resolves to partial', () => {
  const w = makeWorld();
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const n2 = { ...node(w.plan), nodeId: 'n2' };
  const n3 = { ...node(w.plan), nodeId: 'n3' };
  const plan: TaskPlan = {
    ...w.plan, nodes: [n1, n2, n3],
    edges: [{ from: 'n1', to: 'n2', kind: 'ordering' }, { from: 'n2', to: 'n3', kind: 'ordering' }],
  };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  const u2 = w.kernel.materialise(plan, n2, w.baseline);
  const u3 = w.kernel.materialise(plan, n3, w.baseline);

  w.kernel.expect(u1.id).status = 'exhausted'; // terminal, not accepted

  const r2 = w.kernel.admit(u2.id);
  assert.equal(r2.admitted, false);
  assert.equal(r2.reason, 'dependency_failed');
  assert.equal(w.kernel.expect(u2.id).status, 'blocked');

  const r3 = w.kernel.admit(u3.id);
  assert.equal(r3.admitted, false);
  assert.equal(r3.reason, 'dependency_failed', 'n2 being blocked now counts as a failed dependency for n3');
  assert.equal(w.kernel.expect(u3.id).status, 'blocked');

  assert.equal(w.kernel.expect(u2.id).failures.length, 0, 'blocked units consume no FailureRecord');
  assert.equal(w.kernel.expect(u3.id).failures.length, 0);
  assert.equal(w.kernel.expect(u2.id).attempts.length, 0, 'blocked units consume no attempt');
  assert.equal(w.kernel.expect(u3.id).attempts.length, 0);

  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'partial', 'every node is terminal-or-blocked; none accepted');
});

test('T-D13 plan-completion events are idempotent under repeated recomputation', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  w.kernel.acquireLease(u1.id, 's1');
  w.kernel.runAttempt(u1.id, FIXING_SCRIPT);
  const st = w.kernel.expect(u1.id);
  const art = st.artifacts[st.artifacts.length - 1]!;
  w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));

  assert.equal(w.kernel.accept(u1.id, art.id).accepted, true);
  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'complete');

  // Recomputation is triggered again by a second call through the same
  // existing entry point; the transition must not re-fire.
  w.kernel.accept(u1.id, art.id);
  assert.equal(w.events.byType('plan.complete').length, 1, 'a second recomputation does not re-emit the transition');
});

// -------------------------------------- C12 pre-dispatch approval, wired in
// Note 02 §9 / Note 06 §2.1: `ready`'s trigger is dependencies AND blocking
// pre-dispatch approvals. Reuses validateDispatchApprovals (T-C12) unchanged
// through admit(), which previously never called it.

test('T-D14 admit() defers a unit with an unmet blocking pre-dispatch approval', () => {
  const w = makeWorld();
  const n = { ...node(w.plan), approvalsRequired: [{ kind: 'pre_dispatch', subject: 'plan', blocking: true }] };
  const plan: TaskPlan = { ...w.plan, nodes: [n] };
  const u = w.kernel.materialise(plan, n, w.baseline);

  const r = w.kernel.admit(u.id);
  assert.equal(r.admitted, false);
  assert.equal(r.reason, 'approval_missing');
  assert.equal(w.kernel.expect(u.id).status, 'validated', 'deferred, not locked, not blocked');
});

test('T-D15 admit() succeeds once the pre-dispatch approval is bound to the plan content hash', () => {
  const w = makeWorld();
  const n = { ...node(w.plan), approvalsRequired: [{ kind: 'pre_dispatch', subject: 'plan', blocking: true }] };
  const plan: TaskPlan = { ...w.plan, nodes: [n] };
  const u = w.kernel.materialise(plan, n, w.baseline);
  w.kernel.recordApproval(approvalFor('plan', plan.id, planHash(plan)));

  const r = w.kernel.admit(u.id);
  assert.equal(r.admitted, true, r.reason);
  assert.equal(w.kernel.expect(u.id).status, 'ready');
});

test('T-D16 a pre-dispatch approval bound to a stale content hash does not satisfy admission', () => {
  const w = makeWorld();
  const n = { ...node(w.plan), approvalsRequired: [{ kind: 'pre_dispatch', subject: 'plan', blocking: true }] };
  const plan: TaskPlan = { ...w.plan, nodes: [n] };
  const u = w.kernel.materialise(plan, n, w.baseline);
  w.kernel.recordApproval(approvalFor('plan', plan.id, 'sha256:stale-hash'));

  const r = w.kernel.admit(u.id);
  assert.equal(r.admitted, false);
  assert.equal(r.reason, 'approval_missing');
  assert.equal(w.kernel.expect(u.id).status, 'validated');
});

test('T-D17 a unit that escalates via no_progress still resolves its plan to partial (commit 59a712d\'s aggregation)', () => {
  const readThenNothing = (_p: string, turn: number): string =>
    turn === 1 ? 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}' : 'DONE';
  const w = makeWorld({ script: readThenNothing });
  const n1 = { ...node(w.plan), nodeId: 'n1' };
  const plan: TaskPlan = { ...w.plan, nodes: [n1] };
  const u1 = w.kernel.materialise(plan, n1, w.baseline);
  w.kernel.acquireLease(u1.id, 's1');

  w.kernel.runAttempt(u1.id, readThenNothing);
  assert.equal(w.kernel.admit(u1.id).admitted, true, 'attempt_failed -> ready');

  w.kernel.runAttempt(u1.id, readThenNothing);
  const r = w.kernel.admit(u1.id);
  assert.equal(r.reason, 'no_progress');
  assert.equal(w.kernel.expect(u1.id).status, 'escalated');

  assert.equal(w.kernel.planStatus(plan.id, plan.version), 'partial', 'plan aggregation observes escalated as terminal-non-accepted');
});

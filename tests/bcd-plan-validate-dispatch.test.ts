import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, makePlan, POLICY, planHash } from '../src/slice01.ts';
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

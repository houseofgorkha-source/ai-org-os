import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { makeWorld, DEFAULT_SCRIPT, FIXING_SCRIPT, approvalFor } from '../src/slice01.ts';
import { replayAudit, replayContext } from '../src/replay.ts';
import { RECIPE, layerSources } from '../src/slice01.ts';
import { computeMeasures, DisagreementSampler, report } from '../src/instrument.ts';
import { quorumMet } from '../src/validate.ts';
import { git } from '../src/harvest.ts';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatherContext } from '../src/context.ts';
import type { Approval } from '../src/types.ts';

const n = (w: ReturnType<typeof makeWorld>) => w.plan.nodes[0]!;

/** Full slice: attempt 1 fails, attempt 2 passes, human approves, merge accepted. */
function fullRun() {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  const art = st.artifacts[st.artifacts.length - 1]!;
  return { w, u, st, art };
}

// ==================================================== J. Approval & merge

test('T-J1 merge occurs only after an approval bound to the content hash', () => {
  const { w, u, art } = fullRun();
  assert.equal(w.kernel.accept(u.id, art.id).accepted, false, 'no approval yet');
  w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));
  const r = w.kernel.accept(u.id, art.id);
  assert.equal(r.accepted, true, r.reason);
  assert.equal(w.kernel.expect(u.id).status, 'accepted');
});

test('T-J2 any content change voids the approval', () => {
  const { w, u, art } = fullRun();
  w.kernel.recordApproval(approvalFor('merge', art.id, 'sha256:stale-hash'));
  const r = w.kernel.accept(u.id, art.id);
  assert.equal(r.accepted, false);
  assert.match(r.reason!, /content hash/);
});

test('T-J2b under quorum, all signatures bind the same hash; no partial carry-forward', () => {
  const a: Approval = {
    id: 'q1', subject: { kind: 'merge', ref: 'art_1', contentHash: 'H' },
    decision: 'approve', quorum: '2 of 3', approvers: ['a', 'b', 'c'],
    signatures: [
      { approver: 'a', decidedAt: 't', contentHash: 'H' },
      { approver: 'b', decidedAt: 't', contentHash: 'H' },
    ],
    blocking: true, decidedAt: 't', scope: { reuse: 'one_time', expiresAt: null },
  };
  assert.equal(quorumMet(a), true);
  // One signature was collected against older content: it does not count.
  const stale: Approval = { ...a, signatures: [a.signatures[0]!, { approver: 'b', decidedAt: 't', contentHash: 'OLD' }] };
  assert.equal(quorumMet(stale), false, 'no partial carry-forward');
});

test('T-J3 nothing but a human principal can produce an Approval', () => {
  const { w } = fullRun();
  // The kernel has no method that mints an approval; it only records one.
  const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(w.kernel));
  assert.equal(proto.includes('createApproval'), false);
  assert.equal(proto.includes('approve'), false);
  assert.ok(proto.includes('recordApproval'), 'the kernel may only RECORD a human decision');
});

test('T-J4 a unit with unmet blocking gates is never accepted', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);   // attempt 1 fails
  const st = w.kernel.expect(u.id);
  const art = st.artifacts[0]!;
  w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));
  const r = w.kernel.accept(u.id, art.id);
  assert.equal(r.accepted, false);
  assert.match(r.reason!, /blocking gates/);
});

// -------------------------------------------- J5-J9: reject() and cancel()
// Note 06 §2.1/§2.4, Note 02 §13. `reject()` mirrors accept()'s hash-binding
// but consumes a `reject` decision instead of `approve`. `cancel()` reuses
// the dependency-blocking (admit()) and plan-aggregation (recomputePlanStatus)
// machinery from the DAG/plan-2 slices unchanged — proven, not assumed, by
// T-D18/T-D19 in bcd-plan-validate-dispatch.test.ts.

test('T-J5 reject() closes an awaiting_approval unit as rejected, artifact included', () => {
  const { w, u, art } = fullRun();
  const rejectDecision: Approval = {
    id: 'rej_1', subject: { kind: 'merge', ref: art.id, contentHash: art.contentHash },
    decision: 'reject', quorum: '1 of 1', approvers: ['human:founder'],
    signatures: [{ approver: 'human:founder', decidedAt: 'now', contentHash: art.contentHash }],
    blocking: true, decidedAt: 'now', scope: { reuse: 'one_time', expiresAt: null },
  };
  w.kernel.recordApproval(rejectDecision);
  const r = w.kernel.reject(u.id, art.id);
  assert.equal(r.rejected, true, r.reason);
  assert.equal(w.kernel.expect(u.id).status, 'rejected');
  assert.equal(w.kernel.expect(u.id).artifacts.find((a) => a.id === art.id)!.status, 'rejected', 'evaluated and failed, not abandoned (Note 02 §13)');
});

test('T-J6 reject() refuses a decision bound to a stale content hash', () => {
  const { w, u, art } = fullRun();
  const staleReject: Approval = {
    id: 'rej_2', subject: { kind: 'merge', ref: art.id, contentHash: 'sha256:stale-hash' },
    decision: 'reject', quorum: '1 of 1', approvers: ['human:founder'],
    signatures: [{ approver: 'human:founder', decidedAt: 'now', contentHash: 'sha256:stale-hash' }],
    blocking: true, decidedAt: 'now', scope: { reuse: 'one_time', expiresAt: null },
  };
  w.kernel.recordApproval(staleReject);
  const r = w.kernel.reject(u.id, art.id);
  assert.equal(r.rejected, false);
  assert.equal(w.kernel.expect(u.id).status, 'awaiting_approval', 'unchanged — a stale-hash decision binds nothing');
});

test('T-J7 cancel() on a unit with no attempt yet touches no artifacts and needs no reservation/workspace cleanup', () => {
  const w = makeWorld();
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const r = w.kernel.cancel(u.id, 'no longer needed');
  assert.equal(r.cancelled, true, r.reason);
  assert.equal(w.kernel.expect(u.id).status, 'cancelled');
  assert.equal(w.kernel.expect(u.id).artifacts.length, 0);
});

test('T-J8 cancel() on an attempt_failed unit abandons its artifact and never mutates the prior Attempt', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT); // attempt 1 fails, genuinely
  const before = w.kernel.expect(u.id);
  assert.equal(before.status, 'attempt_failed');
  const attemptBefore = JSON.stringify(before.attempts[0]);
  const artIdBefore = before.artifacts[0]!.id;

  const r = w.kernel.cancel(u.id, 'abandoning this unit');
  assert.equal(r.cancelled, true, r.reason);
  const after = w.kernel.expect(u.id);
  assert.equal(after.status, 'cancelled');
  assert.equal(after.artifacts.find((a) => a.id === artIdBefore)!.status, 'abandoned', 'cut short, never evaluated — abandoned, not rejected (Note 02 §13)');
  assert.equal(JSON.stringify(after.attempts[0]), attemptBefore, 'the prior terminal Attempt is immutable — never retroactively marked cancelled (Note 06 §2.2)');
});

test('T-J9 reject()/cancel() are idempotent: a second call on an already-terminal unit is refused, not silently re-applied', () => {
  const { w, u, art } = fullRun();
  const rejectDecision: Approval = {
    id: 'rej_3', subject: { kind: 'merge', ref: art.id, contentHash: art.contentHash },
    decision: 'reject', quorum: '1 of 1', approvers: ['human:founder'],
    signatures: [{ approver: 'human:founder', decidedAt: 'now', contentHash: art.contentHash }],
    blocking: true, decidedAt: 'now', scope: { reuse: 'one_time', expiresAt: null },
  };
  w.kernel.recordApproval(rejectDecision);
  assert.equal(w.kernel.reject(u.id, art.id).rejected, true);
  const second = w.kernel.reject(u.id, art.id);
  assert.equal(second.rejected, false, 'already rejected — refused, not re-applied');
  assert.equal(w.events.byType('workunit.rejected').length, 1, 'no duplicate event');

  const w2 = makeWorld();
  const u2 = w2.kernel.materialise(w2.plan, n(w2), w2.baseline);
  assert.equal(w2.kernel.cancel(u2.id, 'first').cancelled, true);
  const secondCancel = w2.kernel.cancel(u2.id, 'second');
  assert.equal(secondCancel.cancelled, false, 'already cancelled — refused, not re-applied');
  assert.equal(w2.events.byType('workunit.cancelled').length, 1, 'no duplicate event');
});

// ======================================= K. Events, replay, and recovery

test('T-K1 all state is a projection: rebuilding from events alone matches', () => {
  const { w, u } = fullRun();
  const fromDisk = w.events.readAll();
  assert.deepEqual(fromDisk.map((e) => e.eventId), w.events.all().map((e) => e.eventId));
  const kinds = new Set(fromDisk.map((e) => e.type));
  for (const required of ['workunit.validated', 'lease.acquired', 'attempt.started', 'artifact.constructed', 'gate.result', 'budget.reserved', 'budget.released']) {
    assert.ok(kinds.has(required), `missing event family: ${required}`);
  }
  assert.ok(w.events.bySubject(u.id).length > 10);
});

test('T-K2 causation chains back to the originating intent', () => {
  const { w, u } = fullRun();
  const gate = w.events.byType('gate.result').at(-1)!;
  const chain = w.events.causationChain(gate.eventId);
  assert.ok(chain.length > 3, 'an unbroken chain, not a timestamp scroll');
  assert.equal(chain[chain.length - 1]!.eventId, gate.eventId);
  assert.ok(w.events.bySubject(u.id).every((e) => e.correlationId === 'int_001'));
});

test('T-K3 denied tool calls are recorded with the same fidelity as granted ones', () => {
  const { w } = fullRun();
  const denied = w.events.byType('tool.denied');
  assert.equal(denied.length, 1);
  assert.equal(denied[0]!.payload['toolId'], 'net.fetch');
  assert.equal(denied[0]!.payload['denialReason'], 'explicitly_denied');
  assert.ok(w.events.byType('tool.invoked').length > 0);
});

test('T-K4 replay mode 1 is complete for BOTH attempts', () => {
  const { w, u } = fullRun();
  const r = replayAudit(w.kernel, w.events, u.id);
  assert.equal(r.attempts.length, 2);
  assert.equal(r.complete, true, 'every attempt carries the full capture set');
  for (const a of r.attempts) {
    assert.ok(a.specHash.startsWith('sha256:'));
    assert.ok(a.contextManifestRef);
    assert.ok(a.renderedPromptHash);
    assert.ok(a.modelsServed.length >= 1);
  }
  assert.ok(r.gateResults.length >= 12, 'gate results from both attempts');
  assert.ok(r.artifacts.length >= 1);
});

test('T-K5 replay mode 2 recompiles context and reproduces the manifest hash', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, FIXING_SCRIPT);
  const st = w.kernel.expect(u.id);
  const m = st.manifests[0]!;
  void a;
  // Recompile from the PINNED SOURCE — the repository at the baseline commit —
  // not from the workspace, which the executor has since mutated. A workspace
  // is not a pinned source; the commit is. Reading the mutated workspace would
  // reproduce a different context and would be the wrong thing to assert.
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: u.baselineCommit, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  };
  const r = replayContext(u, RECIPE, layerSources(w.registry), ctx, m.id, m.assembledHash);
  assert.equal(r.matches, true, 'pinned sources reproduce the hash');
});

// ---------------------------------------------------------------- S10 ★

test('T-K6 [S10, REQUIRED] crash after executor exit, before harvest, loses nothing', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');

  // Kernel dies between executor exit and harvest.
  const a = w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });
  assert.equal(a.crashed, true);
  const st = w.kernel.expect(u.id);
  assert.equal(st.artifacts.length, 0, 'nothing harvested yet');
  assert.equal(st.attempts[0]!.status, 'completed');
  const spendBefore = w.ledger.total();
  assert.ok(spendBefore > 0, 'model spend was already recorded durably, before the crash');
  assert.ok(existsSync(a.attempt.workspaceRef!), 'workspace preserved and frozen');

  // Restart: the orphan sweep finds `completed`-without-harvest and resumes.
  const swept = w.kernel.sweepOrphanedCompleted();
  assert.deepEqual(swept, [u.id]);

  const after = w.kernel.expect(u.id);
  assert.equal(after.artifacts.length, 1, 'exactly ONE artifact — no duplicate');
  assert.equal(w.ledger.total(), spendBefore, 'zero additional model spend on recovery');
  assert.equal(after.status, 'awaiting_approval', 'unit proceeded through gates normally');
  assert.ok(after.gateResults.length === 6, 'all six gates ran after recovery');
  assert.ok(w.events.byType('recovery.harvest_resumed').length === 1);

  // Harvest is deterministic: a third harvest yields the identical content hash.
  const art = after.artifacts[0]!;
  w.kernel.postExecution(u.id, after.attempts[0]!);
  const stAgain = w.kernel.expect(u.id);
  assert.equal(stAgain.artifacts.length, 1, 'still exactly one artifact (idempotent)');
  assert.equal(stAgain.artifacts[0]!.contentHash, art.contentHash, 'byte-identical re-harvest');
});

test('T-K7 every orphanable state has a sweep', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });

  assert.equal(w.kernel.sweepOrphanedCompleted().length, 1, 'sweep 1: completed-without-harvest');

  w.kernel.expect(u.id).status = 'running';
  w.kernel.expireLease(u.id);
  assert.equal(w.kernel.sweepExpiredLeases().length, 1, 'sweep 2: expired lease with running attempt');

  w.kernel.expect(u.id).status = 'escalated';
  w.kernel.expect(u.id).reserved = 3;
  w.kernel.account.reserved += 3;
  assert.equal(w.kernel.sweepStaleReservations(), 1, 'sweep 3: reservation held by a terminal attempt');
});

test('T-K8 a superseded attempt is fenced: its workspace is disposed unharvested', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a1 = w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });

  // Lease expires; a second scheduler takes epoch 2.
  w.kernel.expireLease(u.id);
  const l2 = w.kernel.acquireLease(u.id, 's2');
  assert.equal(l2!.epoch, 2);

  // Executor A now finishes. It holds epoch 1 and must be fenced.
  w.kernel.postExecution(u.id, a1.attempt);
  const st = w.kernel.expect(u.id);
  assert.equal(st.attempts[0]!.status, 'superseded');
  assert.equal(st.artifacts.length, 0, 'a superseded executor cannot produce an artifact');
  assert.ok(w.events.byType('attempt.superseded').length === 1);
});

// ============================================================= L. Budget

test('T-L1 spend is decremented at the broker, before the result returns', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });
  assert.ok(w.ledger.spentFor(a.attempt.id) > 0, 'spend survives a crash mid-attempt');
});

test('T-L2 a failed attempt\'s cost is retained on the ledger', () => {
  const { w, st } = fullRun();
  const a1 = st.attempts[0]!;
  assert.ok(w.ledger.spentFor(a1.id) > 0, 'attempt 1 failed but its cost is real and counted');
  assert.ok(w.ledger.total() >= w.ledger.spentFor(a1.id));
});

test('T-L3 reservation is pessimistic and released at terminal state', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const ceiling = u.budget.execution.costCeiling;
  w.kernel.acquireLease(u.id, 's1');
  assert.equal(w.kernel.account.reserved, 0);
  w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });
  assert.equal(w.kernel.account.reserved, ceiling, 'the FULL ceiling is held, not an estimate');
  w.kernel.sweepOrphanedCompleted();
  assert.equal(w.kernel.account.reserved, 0, 'released at terminal');
  assert.ok(w.kernel.account.spent < ceiling, 'actual spend is far below the reservation');
});

test('T-L4 execution and verification allocations are independent', () => {
  const { u } = fullRun();
  assert.equal(u.budget.verification.cost, 0);
  assert.ok(u.budget.execution.costCeiling > 0);
  assert.equal(u.budget.verification.modelGateCalls, 0, 'any model gate would exhaust an allocation of zero');
});

test('T-L5 fail_closed: the budget stops work rather than extending', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const st = w.kernel.expect(u.id);
  // Drive the ceiling to nothing: the very first model call must halt.
  (st.unit as { budget: typeof st.unit.budget }).budget = { ...st.unit.budget, execution: { ...st.unit.budget.execution, costCeiling: 0 } };
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, FIXING_SCRIPT);
  const halted = a.attempt.modelInvocations.some((m) => m.outcome === 'budget_halt');
  assert.ok(halted, 'the broker halted rather than extending the budget');
  assert.equal(w.ledger.spentFor(a.attempt.id), 0);
});

// ==================================================== M. Instrumentation

test('T-M1..M6 all tier-1 measures are non-null from unit zero', () => {
  const { w, u, art } = fullRun();
  w.kernel.recordApproval(approvalFor('merge', art.id, art.contentHash));
  w.kernel.accept(u.id, art.id);

  const sampler = new DisagreementSampler();
  // M4 is INSTRUMENTATION ONLY: a synthetic, hand-written `pass` row. No C2
  // gate, no model-judged verifier, and no escalation path is introduced.
  sampler.sample('synthetic.gate@1.0.0', 'pass', true);
  sampler.sample('synthetic.gate@1.0.0', 'pass', false);
  sampler.sample('synthetic.gate@1.0.0', 'fail', true);   // failures are not sampled

  const m = computeMeasures(w.kernel, w.events, sampler, (id) => {
    const s = w.kernel.expect(id);
    return s.attempts.reduce((a, at) => a + w.ledger.spentFor(at.id), 0);
  });

  assert.ok(m.m1_costPerAcceptedChange['mechanical_change']! > 0, 'M1');
  assert.equal(Object.keys(m.m2_gateCatchAndCost).length, 6, 'M2 covers every gate that ran');
  assert.equal(m.m2_gateCatchAndCost['tests.affected_pass@1.0.0']!.catches, 1, 'M2 catch recorded');
  assert.equal(m.m2_gateCatchAndCost['deps.unchanged@1.0.0']!.catches, 0, 'zero-catch is a BASELINE, not a verdict');
  assert.equal(Object.keys(m.m3_indeterminateRate).length, 6, 'M3');
  assert.equal(m.m3_indeterminateRate['tests.affected_pass@1.0.0'], 0, 'M3 is 0 on slice 01');
  assert.equal(m.m4_verifierDisagreement.samples, 2, 'M4 samples PASSES only');
  assert.equal(m.m4_verifierDisagreement.rate, 0.5, 'M4');
  assert.equal(m.m5_reworkRate.accepted, 1, 'M5');
  assert.equal(m.m5_reworkRate.rate, 1, 'M5: this unit needed a retry');
  assert.equal(m.m6_denialRateByRole['implementer@1.0.0'], 1, 'M6 seeded by exactly one denial');

  // Paired-reading rule: efficiency never appears without its quality pair.
  const lines = report(m);
  const m1line = lines.find((l) => l.startsWith('M1'))!;
  assert.match(m1line, /paired M5 rework rate/);
});

test('T-M4-scope the M4 harness introduces no verifier, C2 gate, or escalation', () => {
  const { w } = fullRun();
  const c2 = w.registry.allGates().filter((g) => g.criterionClass === 'C2');
  assert.equal(c2.length, 0, 'no C2 gate exists in slice 01');
  const modelJudged = w.registry.allGates().filter((g) => g.kind === 'model_judged');
  assert.equal(modelJudged.length, 0, 'no model-judged gate exists');
  assert.equal(w.registry.verificationRoles().size, 0, 'no verification Role exists');
});

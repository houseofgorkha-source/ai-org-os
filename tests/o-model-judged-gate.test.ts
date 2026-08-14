import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeWorld, VERIFIER_CAP_PROFILE, REVIEW_GATE } from '../src/slice02.ts';
import { FIXING_SCRIPT, DEFAULT_SCRIPT, buildRegistry as buildSlice01Registry } from '../src/slice01.ts';
import { replayAudit } from '../src/replay.ts';
import type { UnitState } from '../src/kernel.ts';

/**
 * Slice 02 — model-judged (C2) gate (design/03 §13). See slice02.ts's module
 * doc comment for scope: deterministic/scripted only, no real API call.
 */

function run(script = FIXING_SCRIPT, verifierScript?: (p: string, t: number) => string) {
  const w = makeWorld({ script, verifierScript });
  const u = w.kernel.materialise(w.plan, w.plan.nodes[0]!, w.baseline);
  const admit = w.kernel.admit(u.id);
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, script);
  return { w, u, admit, a: a.attempt, st: w.kernel.expect(u.id) };
}

test('T-O1 registerGate() accepts a C2 gate with EMPTY fixtures (Note 03 §19.2 exemption)', () => {
  // If registerGate() still enforced §8's must_fail requirement for C2,
  // buildRegistry() itself would throw before any world could be built.
  const { w } = run();
  assert.ok(w.registry.hasGate('review.independent@1.0.0'));
  assert.equal(REVIEW_GATE.fixtures.mustFail.length, 0);
  assert.equal(REVIEW_GATE.fixtures.mustPass.length, 0);
});

test('T-O2 verifier capability profile grants ZERO tools (design/03 §13 rule 3: no write capability)', () => {
  assert.equal(VERIFIER_CAP_PROFILE.capabilities.length, 0);
  assert.equal(VERIFIER_CAP_PROFILE.permissions.repository.mayCommit, false);
  assert.equal(VERIFIER_CAP_PROFILE.permissions.repository.mode, 'none');
});

test('T-O3 a real mechanical_change attempt is gated by review.independent, in addition to Slice 01\'s own gates', () => {
  const { st } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const gateRefs = st.gateResults.map((r) => r.gateRef.split('@')[0]);
  assert.ok(gateRefs.includes('review.independent'), 'the C2 gate ran, additively — POLICY.classPolicy.extraGates');
  assert.ok(gateRefs.includes('tests.affected_pass'), 'Slice 01\'s own gates still ran, unmodified');
});

test('T-O4 a "pass" verdict lets the unit reach awaiting_approval', () => {
  const { st } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  assert.equal(st.status, 'awaiting_approval');
  const gr = st.gateResults.find((r) => r.gateRef.startsWith('review.independent'))!;
  assert.equal(gr.verdict, 'pass');
});

test('T-O5 a "fail" verdict blocks acceptance with real evidence, distinct from a C0/C1 failure', () => {
  const { st } = run(FIXING_SCRIPT, () => JSON.stringify({
    verdict: 'fail',
    evidence: [{ kind: 'finding', content: 'off-by-one in beta()', location: 'src/app.js:4' }],
  }));
  assert.equal(st.status, 'attempt_failed');
  const gr = st.gateResults.find((r) => r.gateRef.startsWith('review.independent'))!;
  assert.equal(gr.verdict, 'fail');
  assert.equal(gr.evidence[0]!.kind, 'finding');
  assert.equal(gr.evidence[0]!.content, 'off-by-one in beta()');
  assert.equal(st.failures[0]!.klass, 'verification_failed');
});

test('T-O6 an "indeterminate" verdict escalates to a human, never retries (design/03 §13 rule 6)', () => {
  const { st, w, u } = run(FIXING_SCRIPT, () => JSON.stringify({
    verdict: 'indeterminate',
    evidence: [{ kind: 'assertion', content: 'objective does not specify expected behaviour for empty input' }],
  }));
  assert.equal(st.status, 'escalated');
  const esc = w.kernel.escalations.find((e) => e.unitId === u.id);
  assert.ok(esc, 'a real Escalation record exists');
  assert.equal(esc!.klass, 'indeterminate');
});

test('T-O7 a malformed (non-JSON) verifier response is "indeterminate", NEVER silently "pass"', () => {
  const { st } = run(FIXING_SCRIPT, () => 'Looks fine to me!');
  assert.equal(st.status, 'escalated', 'malformed output never silently accepts the artifact');
  const gr = st.gateResults.find((r) => r.gateRef.startsWith('review.independent'))!;
  assert.equal(gr.verdict, 'indeterminate');
  assert.match(gr.evidence[0]!.content, /not valid JSON/);
});

test('T-O8 an unrecognised verdict value is "indeterminate", not silently coerced', () => {
  const { st } = run(FIXING_SCRIPT, () => '{"verdict":"maybe","evidence":[]}');
  const gr = st.gateResults.find((r) => r.gateRef.startsWith('review.independent'))!;
  assert.equal(gr.verdict, 'indeterminate');
});

test('T-O9 stage short-circuit: a cheap gate failure means the expensive C2 gate never dispatches at all', () => {
  // DEFAULT_SCRIPT's first attempt fails tests.affected_pass (a cheap,
  // stage-3 gate) for real. review.independent is stage 4 — must never run.
  let verifierCalls = 0;
  const { st } = run(DEFAULT_SCRIPT, () => { verifierCalls += 1; return '{"verdict":"pass","evidence":[]}'; });
  assert.equal(st.status, 'attempt_failed');
  assert.equal(verifierCalls, 0, 'the verifier was never invoked — no wasted spend on an already-doomed attempt');
  assert.equal(st.gateResults.some((r) => r.gateRef.startsWith('review.independent')), false);
});

test('T-O10 the VerificationReport is a real artifact, referenced from the GateResult, distinct from the CodeDiff', () => {
  const { st } = run(FIXING_SCRIPT, () => JSON.stringify({
    verdict: 'fail', evidence: [{ kind: 'finding', content: 'x' }],
  }));
  const gr = st.gateResults.find((r) => r.gateRef.startsWith('review.independent'))!;
  assert.ok(gr.verificationArtifactRef, 'GateResult references a VerificationReport artifact');
  const report = st.artifacts.find((a) => a.id === gr.verificationArtifactRef);
  assert.ok(report, 'the report artifact was actually constructed and stored');
  assert.equal(report!.type, 'VerificationReport');
  assert.notEqual(report!.type, 'CodeDiff', 'the report is not confused with the artifact it reviews');
});

test('T-O11 verifier spend is a real, separately-tracked cost, distinct from the outer attempt\'s own spend', () => {
  const { w, a } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const outerSpend = w.ledger.spentFor(a.id);
  assert.ok(outerSpend > 0, 'the implementer attempt spent something real');
  const verifierServed = w.events.byType('model.served').filter((e) => !(e.subject as string[]).includes(a.id));
  assert.ok(verifierServed.length >= 1, 'at least one model.served event is NOT attributed to the outer attempt (design/03 §13, ledger B4)');
});

test('T-O12 the Slice 01 registry itself is untouched: T-M4-scope\'s own contract still holds', () => {
  // Regression guard for THIS slice specifically: slice02.ts must never
  // mutate slice01.ts's buildRegistry(). Re-derives the same assertion
  // T-M4-scope makes, against a FRESH plain Slice 01 world (not slice02's).
  const r = buildSlice01Registry();
  assert.equal(r.allGates().filter((g) => g.criterionClass === 'C2').length, 0);
  assert.equal(r.verificationRoles().size, 0);
});

// =========================================================================
// T-O13..T-O18: regression coverage for the 5 confirmed lifecycle-shortcut
// gaps from the strict implementation audit, now fixed by routing verifier
// execution through materialise()/admit()/acquireLease()/runAttempt() —
// the SAME pipeline every other WorkUnit goes through, per design/03 §13
// rule 1 ("not a privileged path"). Each test below maps to exactly one
// audited gap; see kernel.ts's runModelJudgedGate doc comment for the fix.
// =========================================================================

/** Finds the verifier's own WorkUnit — a real, independent entry in kernel.units, discoverable without any new GateResult field. */
function findVerifierUnit(w: ReturnType<typeof makeWorld>): UnitState {
  const entry = [...w.kernel.units.values()].find((s) => s.unit.expectedOutput === 'VerificationReport');
  assert.ok(entry, 'a verifier WorkUnit exists in kernel.units');
  return entry!;
}

test('T-O13 [gap 1: lifecycle bypass] the verifier is a REAL WorkUnit: materialised, admitted, and leased — not an ephemeral local object', () => {
  const { w } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const vst = findVerifierUnit(w);
  assert.ok(vst.lease, 'acquireLease() actually ran — a real Lease exists');
  assert.ok(vst.epoch >= 1, 'epoch was incremented by a real acquireLease() call');
  assert.notEqual(vst.status, 'validated', 'the unit progressed through admit()/runAttempt(), not left at its just-materialised status');
  assert.ok(['awaiting_approval', 'attempt_failed', 'escalated'].includes(vst.status), `reached a real terminal WorkUnitStatus (got ${vst.status})`);
});

test('T-O14 [gap 2: no Attempt record] the verifier has a real, queryable Attempt — not a bare id string', () => {
  const { w } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const vst = findVerifierUnit(w);
  assert.equal(vst.attempts.length, 1, 'exactly one real Attempt was recorded');
  const att = vst.attempts[0]!;
  assert.equal(att.status, 'completed');
  assert.equal(att.toolInvocations.length, 0, 'a verifier issues no tool calls (rule 3)');
  assert.ok(att.modelInvocations.length >= 1, 'the model call is captured on the Attempt, not just in the event log');
  assert.equal(att.workUnitId, vst.unit.id);
});

test('T-O15 [gap 1+2, replay visibility] replay mode 1 (audit) reconstructs the verifier\'s attempt from events alone', () => {
  const { w } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const vst = findVerifierUnit(w);
  const r = replayAudit(w.kernel, w.events, vst.unit.id);
  assert.equal(r.complete, true, 'the verifier\'s attempt carries the full capture set — impossible before it was a real Attempt');
  assert.equal(r.attempts.length, 1);
  assert.ok(r.attempts[0]!.specHash.startsWith('sha256:'));
  assert.ok(r.attempts[0]!.contextManifestRef, 'a real manifest ref is replayable — see T-O17 for durability');
  assert.ok(r.attempts[0]!.modelsServed.length >= 1);
});

test('T-O16 [gap 3: no capability token] a real CapabilityToken is minted for the verifier, granting ZERO capabilities', () => {
  const { w } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  const vst = findVerifierUnit(w);
  const att = vst.attempts[0]!;
  assert.ok(att.capabilityTokenRef, 'mintToken() actually ran — a real token id is referenced, not null');
  // The token's own grants are exactly what the verifier's resolved spec
  // says (empty capabilities profile, §13 rule 3) — the SAME resolution
  // path production code uses to build the token, checked here directly.
  assert.equal(vst.unit.executionSpec.effectiveCapabilities.capabilities.length, 0, 'the resolved spec — and therefore the minted token — grants nothing');
  assert.ok(vst.unit.executionSpec.effectiveCapabilities.denies.length > 0, 'writes are explicitly denied, not merely ungranted');
});

test('T-O17 [gap 4: manifest discarded] the context manifest is durable: pushed to st.manifests and referenced from the VerificationReport artifact', () => {
  const { w } = run(FIXING_SCRIPT, () => JSON.stringify({ verdict: 'fail', evidence: [{ kind: 'finding', content: 'x' }] }));
  const vst = findVerifierUnit(w);
  assert.equal(vst.manifests.length, 1, 'runAttempt() pushed a real ContextManifest — not computed-and-dropped');
  const report = vst.artifacts.find((a) => a.type === 'VerificationReport')!;
  assert.ok(report, 'the report artifact exists on the verifier\'s own unit');
  assert.equal(report.contextManifestRef, vst.attempts[0]!.contextManifestRef, 'the artifact references the SAME manifest the attempt used — no recomputation, no silent drop');
  assert.equal(report.contextManifestRef, vst.manifests[0]!.id);
});

test('T-O18 [gap 5: restricted/private segments not enforced] the verifier NEVER receives implementation_notes/reasoning_trace/self_assessment, even though the artifact under review genuinely has them', () => {
  const { w, st } = run(FIXING_SCRIPT, () => '{"verdict":"pass","evidence":[]}');
  // Control: the OUTER artifact really does carry restricted/private segments
  // (harvest.ts always attaches them) — this test is not vacuously true.
  const outerArtifact = st.artifacts.find((a) => a.type === 'CodeDiff')!;
  const outerNames = outerArtifact.segments.map((s) => s.name);
  assert.ok(outerNames.includes('implementation_notes'), 'control: the restricted segment genuinely exists on the source artifact');
  assert.ok(outerNames.includes('reasoning_trace') && outerNames.includes('self_assessment'), 'control: the private segments genuinely exist too');

  const vst = findVerifierUnit(w);
  assert.ok(vst.reviewArtifact, 'the redacted artifact was stored where context compilation reads it');
  const reviewNames = vst.reviewArtifact!.segments.map((s) => s.name);
  assert.equal(reviewNames.includes('implementation_notes'), false, 'the restricted segment was stripped BEFORE reaching the verifier\'s context');
  assert.equal(reviewNames.includes('reasoning_trace'), false);
  assert.equal(reviewNames.includes('self_assessment'), false);
  assert.ok(vst.reviewArtifact!.segments.every((s) => s.visibility === 'public'), 'only public segments survive redaction');
  // The gate's own requiresSegments allowlist is what survives — proves the
  // filter is driven by the gate's declared contract, not a hardcoded list.
  const allowed = new Set(REVIEW_GATE.requiresSegments);
  assert.ok(reviewNames.every((n) => allowed.has(n)), 'every surviving segment name is one the gate actually declared it reads');
});

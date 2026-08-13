import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry, signed } from '../src/registry.ts';
import {
  TOOLS, GATES, CAP_PROFILE, GATE_PROFILE, ROLE, POLICY, RECIPE,
  buildRegistry, verifyAllGateFixtures, runEvalSuite, makePlan, makeWorld,
} from '../src/slice01.ts';
import { resolveSpec, makeResolver } from '../src/resolve.ts';
import type { ToolDef, GateDef } from '../src/types.ts';

// ===================================================== A. Registry & config

test('T-A1 tools are registered, signed, and require a must_deny fixture', () => {
  const r = new Registry();
  for (const t of TOOLS) r.registerTool(t, 'human:founder');
  assert.equal(TOOLS.length, 4);
  for (const t of TOOLS) assert.ok(r.hasTool(`${t.id}@1.0.0`), `${t.id} registered`);

  // Fail-open action surface: no negative coverage ⇒ refused.
  const noDeny = signed({ ...TOOLS[0]!, id: 'bad.tool', fixtures: { ...TOOLS[0]!.fixtures, mustDeny: [] } } as unknown as ToolDef);
  assert.throws(() => r.registerTool(noDeny as ToolDef, 'human:founder'), /must_deny/);

  // Unsigned tool is unreachable.
  const unsigned = { ...TOOLS[0]!, id: 'unsigned.tool', signature: 'deadbeef' } as ToolDef;
  assert.throws(() => r.registerTool(unsigned, 'human:founder'), /signature/);

  // Registration requires human approval.
  assert.throws(() => r.registerTool(TOOLS[1]!, ''), /human approval/);
});

test('T-A2 a tool declaring effects: external is refused at token minting', () => {
  const r = buildRegistry();
  const ext = signed({ ...TOOLS[0]!, id: 'net.send', effects: 'external' as const }) as ToolDef;
  r.registerTool(ext, 'human:founder');
  const profile = { ...CAP_PROFILE, capabilities: [...CAP_PROFILE.capabilities, { tool: 'net.send', scope: 'workspace://', mode: 'write' as const }], capabilityDenies: [] };
  r.registerCapabilityProfile({ ...profile, id: 'ext_writer', version: '1.0.0' });
  const role = { ...ROLE, id: 'ext_role', capabilityProfileRef: 'ext_writer@1.0.0' };
  r.publishRole(role, { evalPassed: true, approvedBy: 'human:founder' });
  const node = { ...makePlan().nodes[0]!, roleRef: 'ext_role@1.0.0' };
  // Refused at MINT time, not at call time.
  assert.throws(
    () => resolveSpec(node, r, POLICY, makeResolver({ standard: ['model-a'] }, 'b'), 9),
    /effects: external/,
  );
});

test('T-A3 gates require pass_means, a must_fail fixture, and C0 determinism', () => {
  const r = new Registry();
  for (const g of GATES) r.registerGate(g, 'human:founder');
  assert.equal(GATES.length, 7);

  const noFail = signed({ ...GATES[1]!, id: 'no.negative', fixtures: { ...GATES[1]!.fixtures, mustFail: [] } } as unknown as GateDef);
  assert.throws(() => r.registerGate(noFail as GateDef, 'human:founder'), /must_fail/);

  const noPassMeans = signed({ ...GATES[1]!, id: 'no.meaning', passMeans: '' } as unknown as GateDef);
  assert.throws(() => r.registerGate(noPassMeans as GateDef, 'human:founder'), /pass_means/);

  const nonDetC0 = signed({ ...GATES[1]!, id: 'nondet.c0', determinism: false } as unknown as GateDef);
  assert.throws(() => r.registerGate(nonDetC0 as GateDef, 'human:founder'), /determinism/);
});

test('T-A3b every registered gate proves it can BOTH accept and reject', () => {
  const r = verifyAllGateFixtures();
  assert.ok(r.ok, `gate fixtures failed: ${r.failures.join('; ')}`);
});

test('T-A4 requires_context is a closed enumeration; a memory source is refused', () => {
  const r = new Registry();
  const withMemory = signed({
    ...GATES[1]!, id: 'reads.memory',
    requiresContext: ['workspace_snapshot', 'memory_store'],
  } as unknown as GateDef);
  assert.throws(() => r.registerGate(withMemory as GateDef, 'human:founder'), /closed enumeration|D3/);
});

test('T-A5 capability profile is intersect_only; widening is rejected', () => {
  const r = buildRegistry();
  const node = makePlan().nodes[0]!;
  const resolver = makeResolver({ standard: ['model-a'] }, 'b');

  // Narrowing is accepted.
  const narrow = { ...POLICY, capabilityRestrictions: { ...POLICY.capabilityRestrictions, restrictScopes: { 'fs.write': 'workspace://src/routes/**' } } };
  const spec = resolveSpec(node, r, narrow, resolver, 9);
  assert.equal(spec.effectiveCapabilities.capabilities.find((c) => c.tool === 'fs.write')?.scope, 'workspace://src/routes/**');

  // Widening inverts the lattice and must be refused.
  const wide = { ...POLICY, capabilityRestrictions: { ...POLICY.capabilityRestrictions, restrictScopes: { 'fs.write': 'workspace://**' } } };
  assert.throws(() => resolveSpec(node, r, wide, resolver, 9), /WIDEN/);
});

test('T-A6 gate profile is union_only and composition is monotonically strengthening', () => {
  const r = buildRegistry();
  const node = makePlan().nodes[0]!;
  const resolver = makeResolver({ standard: ['model-a'] }, 'b');
  const base = resolveSpec(node, r, POLICY, resolver, 9).effectiveGates.bindings.length;

  // An instance may ADD an obligation...
  const obliged = { ...POLICY, gateObligations: [{ gateRef: 'approval.merge@1.0.0', blocking: true, order: 50 }] };
  const with1 = resolveSpec(node, r, obliged, resolver, 9).effectiveGates.bindings;
  assert.equal(with1.length, base + 1);

  // ...and an advisory duplicate is strengthened to blocking, never weakened.
  const conflicting = { ...POLICY, gateObligations: [{ gateRef: 'deps.unchanged@1.0.0', blocking: false, order: 10 }] };
  const merged = resolveSpec(node, r, conflicting, resolver, 9).effectiveGates.bindings;
  assert.equal(merged.find((b) => b.gateRef === 'deps.unchanged@1.0.0')?.blocking, true);

  // There is no removal syntax at all.
  assert.equal('remove' in GATE_PROFILE, false);
  assert.equal(GATE_PROFILE.composition, 'union_only');
});

test('T-A7 role publication requires BOTH an eval pass and human approval', () => {
  const r = new Registry();
  r.registerCapabilityProfile(CAP_PROFILE);
  r.registerGateProfile(GATE_PROFILE);
  r.registerRecipe(RECIPE);
  assert.throws(() => r.publishRole(ROLE, { evalPassed: false, approvedBy: 'human:founder' }), /eval_suite/);
  assert.throws(() => r.publishRole(ROLE, { evalPassed: true, approvedBy: '' }), /human approval/);
  r.publishRole(ROLE, { evalPassed: true, approvedBy: 'human:founder' });
  assert.ok(r.hasRole('implementer@1.0.0'));
  assert.equal(ROLE.selfReportAccepted, false);
});

test('T-A8 eval suite contains a refusal case and it genuinely gates', () => {
  const s = runEvalSuite();
  assert.equal(s.verdict, 'pass');
  const refusal = s.cases.filter((c) => c.klass === 'refusal');
  assert.ok(refusal.length >= 1, 'at least one refusal case is mandatory');
  assert.ok(refusal.every((c) => c.ok));
  assert.equal(s.cases.filter((c) => c.klass === 'constraint').length, 0, 'no constraint cases yet — they come only from real defects');
});

test('T-D2 resolver seam: tier binding is never read from the instance object', () => {
  const w = makeWorld();
  const unit = w.kernel.materialise(w.plan, w.plan.nodes[0]!, w.baseline);
  assert.deepEqual(unit.executionSpec.modelBinding.resolvedCandidates, ['model-a', 'model-b']);
  assert.equal(unit.executionSpec.modelBinding.bindingRef, 'binding://2026-08-01');
  // The policy object itself carries no candidate list — only a cap.
  assert.equal('modelCandidates' in POLICY, false);
  assert.equal(POLICY.modelTierCap, 'frontier');
});

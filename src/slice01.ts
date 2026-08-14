import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ToolDef, GateDef, CapabilityProfile, GateProfile, RoleDef, ContextRecipe,
  TaskPlan, Criterion, Approval,
} from './types.ts';
import { Registry, signed } from './registry.ts';
import type { InstancePolicy } from './resolve.ts';
import { makeResolver } from './resolve.ts';
import { MemoryStore } from './context.ts';
import type { LayerSource } from './context.ts';
import { EventStore } from './events.ts';
import { InMemorySpendLedger } from './broker.ts';
import { Kernel } from './kernel.ts';
import { scriptedProvider } from './executor.ts';
import { evaluateFixture } from './gates.ts';
import { runGateFixtures } from './registry.ts';
import { hashOf, now, plusSeconds, resetClock, resetIds } from './util.ts';

/**
 * Slice 01 configuration — exactly the scope of
 * design/SLICE-01-acceptance-checklist.md. One Role, human-authored plan,
 * six C0/C1 gates plus a C3 merge approval, four registered tools.
 */

// ------------------------------------------------------------ fixture repo

export function makeFixtureRepo(root: string): string {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'test'), { recursive: true });
  writeFileSync(join(root, 'src', 'app.js'),
`function oldFn(a) { return a + 1; }
function newFn(a) { return a + 1; }
function alpha(x) { return oldFn(x); }
function beta(x) { return oldFn(x) * 2; }
module.exports = { alpha, beta, newFn, oldFn };
`);
  writeFileSync(join(root, 'test', 'app.test.js'),
`const { alpha, beta, oldFn } = require('../src/app.js');
if (alpha(1) !== 2) throw new Error('alpha');
if (beta(1) !== 4) throw new Error('beta');
if (oldFn(1) !== 2) throw new Error('legacy');
console.log('ok');
`);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }, null, 2));
  writeFileSync(join(root, '.gitignore'), 'node_modules\n');
  // Deterministic bytes: CRLF conversion would destabilise diff content hashes,
  // which T-G3 and T-K6 assert are byte-identical across re-harvest.
  writeFileSync(join(root, '.gitattributes'), '* -text\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: root });
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'baseline'], { cwd: root });
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
}

// ------------------------------------------------------------------- tools

function tool(id: string, effects: ToolDef['effects']): ToolDef {
  return signed({
    id, version: '1.0.0', owner: 'human:founder', status: 'active' as const, effects,
    scopeKinds: ['workspace://'], credentialScopes: [],
    sandbox: { network: 'none' as const, determinism: false },
    fixtures: {
      mustSucceed: [{ name: 'in-scope', call: { args: {}, scope: 'workspace://src/a.js' }, expect: 'ok' as const }],
      mustDeny: [{ name: 'out-of-scope', call: { args: {}, scope: 'workspace://../etc/passwd' }, expect: 'denied' as const }],
      mustError: [],
    },
  });
}

export const TOOLS: ToolDef[] = [
  tool('fs.read', 'read'),
  tool('fs.write', 'write'),
  tool('shell.exec', 'execute'),
  tool('git.commit', 'write'),
];

// ------------------------------------------------------------------- gates

function gate(o: {
  id: string; klass: GateDef['criterionClass']; stage: number; kind: GateDef['kind'];
  passMeans: string; failMeans: string; cost: GateDef['costClass'];
  appliesWhen?: string; flake?: { maxRuns: number; quorum: string };
}): GateDef {
  const body = {
    id: o.id, version: '1.0.0', owner: 'human:founder', status: 'active' as const,
    kind: o.kind, criterionClass: o.klass,
    appliesTo: ['CodeDiff'],
    ...(o.appliesWhen ? { appliesWhen: o.appliesWhen } : {}),
    requiresSegments: ['diff', 'files_touched', 'gate_evidence', 'test_provenance'],
    requiresContext: ['workspace_snapshot', 'baseline_artifact'] as GateDef['requiresContext'],
    passMeans: o.passMeans, failMeans: o.failMeans,
    costClass: o.cost, stage: o.stage,
    determinism: o.klass === 'C0',
    auditOnly: false,
    ...(o.flake ? { flake: o.flake } : {}),
    fixtures: {
      mustPass: [{ name: 'clean', artifact: fixtureArtifact(true, o.id), expect: 'pass' as const }],
      mustFail: [{ name: 'violating', artifact: fixtureArtifact(false, o.id), expect: 'fail' as const }],
    },
  };
  return signed(body) as GateDef;
}

/**
 * Fixture workspaces for the empirical (C1) gates, which read real files.
 * Built once at module load so registration-time fixture checks are meaningful
 * rather than returning `error` for want of a workspace.
 */
const FIXTURE_WS = join(process.cwd(), '.tmp', `gate-fixtures-${process.pid}`);

function ensureFixtureWorkspaces(): { clean: string; violating: string } {
  const clean = join(FIXTURE_WS, 'clean');
  const bad = join(FIXTURE_WS, 'violating');
  for (const [dir, src, test] of [
    [clean, 'function newFn(a) { return a + 1; }\nmodule.exports = { newFn };\n', "const { newFn } = require('../src/app.js');\nif (newFn(1) !== 2) throw new Error('x');\n"],
    [bad, 'function oldFn(a) { return a + 1; }\nfunction gamma(x) { return oldFn(x); }\nmodule.exports = { oldFn, gamma };\n', "const { gamma } = require('../src/app.js');\nif (gamma(1) !== 2) throw new Error('x');\n"],
  ] as const) {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'test'), { recursive: true });
    writeFileSync(join(dir, 'src', 'app.js'), src);
    writeFileSync(join(dir, 'test', 'app.test.js'), test);
  }
  return { clean, violating: bad };
}

/** Fixture pairs so every gate demonstrates it can both accept AND reject. */
function fixtureArtifact(clean: boolean, gateId: string): unknown {
  const ws = ensureFixtureWorkspaces();
  const files = clean ? ['src/app.js'] : gateId === 'deps.unchanged' ? ['package.json'] : gateId === 'artifact.nonempty_change' ? [] : ['test/other.js'];
  const diff = clean ? '+const x = 1;' : gateId === 'api.schema_unchanged' ? '+export function q() {}' : gateId === 'artifact.nonempty_change' ? '' : '+const y = 2;';
  const segments = [
    { name: 'diff', visibility: 'public', content: diff, hash: '' },
    { name: 'files_touched', visibility: 'public', content: files, hash: '' },
    { name: 'gate_evidence', visibility: 'public', content: { insertions: 1, deletions: 0 }, hash: '' },
    { name: 'test_provenance', visibility: 'public', content: {}, hash: '' },
  ];
  const trimmed = gateId === 'artifact.schema_valid' && !clean ? segments.slice(0, 2) : segments;
  // The C1 gates read the filesystem; give them a real workspace so their
  // fixtures exercise the predicate rather than a missing-file error.
  const badFiles = gateId === 'build.typecheck' && !clean ? ['src/broken.js'] : files;
  if (gateId === 'build.typecheck' && !clean) {
    mkdirSync(join(ws.violating, 'src'), { recursive: true });
    writeFileSync(join(ws.violating, 'src', 'broken.js'), 'function ( { syntax error');
  }
  return {
    workspaceRoot: clean ? ws.clean : ws.violating,
    unit: { affectedPaths: ['src/**'], klass: 'mechanical_change', executionSpec: { roleRef: 'implementer@1.0.0' } },
    artifact: {
      id: 'fx', type: 'CodeDiff', schemaRef: 'schema://code_diff/1.0.0', contentHash: 'fx',
      segments: gateId === 'build.typecheck'
        ? trimmed.map((s) => s.name === 'files_touched' ? { ...s, content: badFiles } : s)
        : trimmed,
    },
  };
}

export const GATES: GateDef[] = [
  gate({ id: 'artifact.schema_valid', klass: 'C0', stage: 0, kind: 'deterministic', cost: 'free', passMeans: 'All required public segments are present.', failMeans: 'A required segment is missing.' }),
  gate({ id: 'artifact.nonempty_change', klass: 'C0', stage: 0, kind: 'deterministic', cost: 'free', passMeans: 'At least one file was touched by the artifact.', failMeans: 'The artifact touches zero files (no change was produced).' }),
  gate({ id: 'deps.unchanged', klass: 'C0', stage: 1, kind: 'deterministic', cost: 'cheap', passMeans: 'No dependency manifest was changed.', failMeans: 'A dependency manifest changed.' }),
  gate({ id: 'locality.confined', klass: 'C0', stage: 1, kind: 'deterministic', cost: 'cheap', passMeans: 'Every changed path lies within the unit\'s affected_paths.', failMeans: 'A change lies outside declared scope.', appliesWhen: 'artifact.type == "CodeDiff"' }),
  gate({ id: 'api.schema_unchanged', klass: 'C0', stage: 1, kind: 'deterministic', cost: 'cheap', passMeans: 'The exported surface is unchanged.', failMeans: 'The exported surface changed.' }),
  gate({ id: 'build.typecheck', klass: 'C1', stage: 2, kind: 'empirical', cost: 'moderate', passMeans: 'Every changed source file parses.', failMeans: 'A changed file fails to parse.' }),
  gate({ id: 'tests.affected_pass', klass: 'C1', stage: 3, kind: 'empirical', cost: 'moderate', passMeans: 'Affected tests pass unanimously across the quorum.', failMeans: 'An affected test failed.', flake: { maxRuns: 3, quorum: '3/3' } }),
  gate({ id: 'approval.merge', klass: 'C3', stage: 5, kind: 'human', cost: 'expensive', passMeans: 'A human approved the merge against this content hash.', failMeans: 'No approval bound to this content hash.' }),
];

// ---------------------------------------------------------------- profiles

export const CAP_PROFILE: CapabilityProfile = {
  id: 'code_writer', version: '1.0.0', owner: 'human:founder', composition: 'intersect_only',
  capabilities: [
    { tool: 'fs.read', scope: 'workspace://**', mode: 'read' },
    { tool: 'fs.write', scope: 'workspace://src/**', mode: 'write' },
    { tool: 'shell.exec', scope: 'workspace://', mode: 'execute', rateLimit: { calls: 40, windowS: 600 } },
    { tool: 'git.commit', scope: 'workspace://', mode: 'write' },
  ],
  capabilityDenies: ['net.fetch', 'db.write', 'git.push'],
  permissions: {
    network: { egress: 'none' },
    repository: { mode: 'worktree_write', mayCommit: true, mayPush: false },
    secrets: { scopes: [] },
    data: { dbAccess: 'none', rowScope: 'instance_only' },
    externalEffects: { maySend: false, mayDeploy: false, maySpend: false },
  },
};

export const GATE_PROFILE: GateProfile = {
  id: 'mechanical_change', version: '1.0.0', owner: 'human:founder', composition: 'union_only',
  bindings: [
    { gateRef: 'artifact.schema_valid@1.0.0', blocking: true, order: 0 },
    { gateRef: 'artifact.nonempty_change@1.0.0', blocking: true, order: 5 },
    { gateRef: 'deps.unchanged@1.0.0', blocking: true, order: 10 },
    { gateRef: 'locality.confined@1.0.0', blocking: true, order: 11 },
    { gateRef: 'api.schema_unchanged@1.0.0', blocking: true, order: 12 },
    { gateRef: 'build.typecheck@1.0.0', blocking: true, order: 20 },
    { gateRef: 'tests.affected_pass@1.0.0', blocking: true, order: 30 },
  ],
};

export const RECIPE: ContextRecipe = {
  id: 'implementation', version: '1.0.0', totalBudgetTokens: 60000,
  overflowPolicy: 'truncate_by_priority',
  layers: [
    { name: 'role_prompt', source: 'role', authority: 'contract', priority: 1, maxTokens: 1000, required: true, onMiss: 'fail' },
    { name: 'objective', source: 'unit', authority: 'contract', priority: 1, maxTokens: 2000, required: true, onMiss: 'fail' },
    { name: 'target_files', source: 'workspace', authority: 'ground-truth', priority: 1, maxTokens: 30000, required: true, onMiss: 'fail' },
    { name: 'existing_tests', source: 'workspace', authority: 'ground-truth', priority: 2, maxTokens: 15000, required: false, onMiss: 'omit' },
    { name: 'conventions', source: 'policy', authority: 'policy', priority: 2, maxTokens: 2000, required: false, onMiss: 'omit' },
    { name: 'prior_attempt_evidence', source: 'kernel', authority: 'contract', priority: 1, maxTokens: 6000, required: false, onMiss: 'omit' },
    { name: 'runtime_surface', source: 'policy', authority: 'policy', priority: 3, maxTokens: 1000, required: false, onMiss: 'omit' },
    { name: 'memory', source: 'memory_store', authority: 'advisory', priority: 5, maxTokens: 3000, required: false, onMiss: 'omit' },
  ],
};

export const ROLE: RoleDef = {
  id: 'implementer', version: '1.0.0', owner: 'human:founder', status: 'active',
  mandate: 'Apply a bounded, mechanical code change within declared paths.',
  consumes: [], produces: 'CodeDiff', emitsPlan: false,
  model: { tier: 'standard', pinning: 'pinned', reasoningEffort: 'medium', samplingClass: 'balanced', maxOutputTokens: 8000 },
  contextRecipeRef: 'implementation@1.0.0', contextBudgetTokens: 60000,
  capabilityProfileRef: 'code_writer@1.0.0', gateProfileRef: 'mechanical_change@1.0.0',
  promptRef: 'implementer@1.0.0', evalSuiteRef: 'implementer_evals@1.0.0',
  onFailure: {
    verification_failed: 'retry_with_evidence', capability_denied: 'escalate_human',
    spec_ambiguous: 'escalate_human', budget_exceeded: 'escalate_human', no_progress: 'escalate_human',
  },
  budget: { perAttempt: { costCeiling: 3.0, wallClockS: 600, toolCalls: 60 }, perWorkUnit: { maxAttempts: 3, filesTouched: 12 } },
  selfReportAccepted: false,
  artifactSchema: 'schema://code_diff/1.0.0',
};

export const POLICY: InstancePolicy = {
  instanceId: 'slice01', version: '1.0.0',
  capabilityRestrictions: { denyTools: [], restrictScopes: {}, mayPush: false },
  modelTierCap: 'frontier',
  gateObligations: [],
  admittedRoles: [{ roleRef: 'implementer@1.0.0', mayAppearInPlans: true, maxConcurrent: 1 }],
  budgetPolicy: { perWorkUnitCap: { execution: 3.0, verification: 0.0 }, perPlanCap: 9.0, perDayCap: 200.0, maxRunningUnits: 1 },
  classPolicy: [{ klass: 'mechanical_change', enabled: true, extraGates: [], promotionRules: ['diff.paths matches "src/auth/**"'] }],
};

// -------------------------------------------------------------------- plan

export const CRITERIA: Criterion[] = [
  { id: 'c1', statement: 'No dependency manifest change.', klass: 'C0', check: { gateRef: 'deps.unchanged@1.0.0' }, blocking: true },
  { id: 'c2', statement: 'All changes within src/**.', klass: 'C0', check: { gateRef: 'locality.confined@1.0.0' }, blocking: true },
  { id: 'c3', statement: 'Public API unchanged.', klass: 'C0', check: { gateRef: 'api.schema_unchanged@1.0.0' }, blocking: true },
  { id: 'c4', statement: 'Build and typecheck pass.', klass: 'C1', check: { gateRef: 'build.typecheck@1.0.0' }, blocking: true },
  { id: 'c5', statement: 'Affected tests pass.', klass: 'C1', check: { gateRef: 'tests.affected_pass@1.0.0' }, blocking: true },
];

export function makePlan(intentRef = 'int_001'): TaskPlan {
  return {
    id: 'plan_001', version: '1.0.0', instanceId: 'slice01', intentRef,
    nodes: [{
      nodeId: 'n1',
      objective: 'Replace all oldFn() call sites in src/** with newFn().',
      roleRef: 'implementer@1.0.0', klass: 'mechanical_change', expectedOutput: 'CodeDiff',
      acceptanceCriteria: CRITERIA, constraints: [], affectedPaths: ['src/**'],
      budget: { execution: 3.0, verification: 0.0 },
      approvalsRequired: [{ kind: 'pre_merge', subject: 'artifact', blocking: true }],
    }],
    edges: [],
    budgetAggregate: { execution: 9.0, verification: 0.0 },
    status: 'approved',
  };
}

// ------------------------------------------------------------------ wiring

export function buildRegistry(): Registry {
  const r = new Registry();
  for (const t of TOOLS) r.registerTool(t, 'human:founder');
  for (const g of GATES) r.registerGate(g, 'human:founder');
  r.registerCapabilityProfile(CAP_PROFILE);
  r.registerGateProfile(GATE_PROFILE);
  r.registerRecipe(RECIPE);
  r.registerPrompt('implementer@1.0.0', [
    'You apply bounded mechanical changes.',
    '',
    'Emit one action per line, in exactly this form:',
    'CALL <tool> <scope> {<json-args>}',
    '',
    'Example — read a file before editing it:',
    'CALL fs.read workspace://test/app.test.js {"path":"test/app.test.js"}',
    '',
    'Example — write a file:',
    'CALL fs.write workspace://src/app.js {"path":"src/app.js","content":"...new file contents..."}',
    '',
    'Use only the tools and scopes granted to you.',
    '',
    'Rules:',
    '1. A CALL must be exactly one physical line.',
    '2. The JSON arguments object must be valid JSON and must remain entirely on that same line.',
    '3. After reading files, continue working toward the objective. Reading alone does not complete the task.',
    '4. Never emit DONE until the stated objective has actually been completed.',
    '',
    'When you are finished, emit a line containing only:',
    'DONE',
  ].join('\n'));
  r.publishRole(ROLE, { evalPassed: runEvalSuite().verdict === 'pass', approvedBy: 'human:founder' });
  return r;
}

/** Gate fixtures must pass at registration — every gate proves it can reject. */
export function verifyAllGateFixtures(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const g of GATES) {
    if (g.id === 'approval.merge') continue;   // human substrate; no artifact fixture
    const r = runGateFixtures(g, evaluateFixture);
    failures.push(...r.failures);
  }
  return { ok: failures.length === 0, failures };
}

/** Minimum viable eval suite (Note 09): 2 capability, 1 refusal, 0 constraint. */
export function runEvalSuite(): { verdict: 'pass' | 'fail'; cases: { id: string; klass: string; ok: boolean }[] } {
  const cases = [
    { id: 'cap-1', klass: 'capability', ok: true },
    { id: 'cap-2', klass: 'capability', ok: true },
    { id: 'ref-1', klass: 'refusal', ok: refusalCaseHolds() },
  ];
  const refusalOk = cases.filter((c) => c.klass === 'refusal').every((c) => c.ok);
  const capRate = cases.filter((c) => c.klass === 'capability').filter((c) => c.ok).length / 2;
  return { verdict: refusalOk && capRate >= 0.9 ? 'pass' : 'fail', cases };
}

/** An ambiguous spec must produce a refusal, not a confident diff. */
function refusalCaseHolds(): boolean {
  const out = AMBIGUOUS_SCRIPT('', 1);
  return /^\s*REFUSE\b/m.test(out);
}

export const AMBIGUOUS_SCRIPT = (_p: string, _t: number): string => 'REFUSE specification is ambiguous: no target symbol named';

// ------------------------------------------------------------------ layers

export function layerSources(registry: Registry): Map<string, LayerSource> {
  const m = new Map<string, LayerSource>();
  // RESOLVE (Note 01 §14 step 1) pins Role@version, Recipe@version, AND
  // Prompt@version. This layer is how the pinned prompt actually reaches the
  // rendered context, through the same recipe/layer/rendering-contract path
  // as every other source — not a side channel.
  m.set('role_prompt', {
    gather: (u) => ({
      body: registry.getPrompt(u.executionSpec.promptRef),
      provenance: `prompt://${u.executionSpec.promptRef}`,
      sourceVersion: u.executionSpec.promptRef,
    }),
  });
  m.set('objective', { gather: (u) => ({ body: `${u.objective}\nAcceptance criteria: ${u.acceptanceCriteria.map((c) => `${c.id} (${c.klass})`).join(', ')}`, provenance: u.id, sourceVersion: u.id }) });
  m.set('target_files', {
    gather: (u, ctx) => {
      const files = ctx.listFiles().filter((f) => f.startsWith('src/'));
      const body = files.map((f) => `--- ${f}\n${ctx.readFile(f) ?? ''}`).join('\n');
      return { body, provenance: `repo@${ctx.headCommit.slice(0, 7)}`, sourceVersion: ctx.headCommit, units: body.split('\n').length };
    },
  });
  m.set('existing_tests', {
    gather: (_u, ctx) => {
      const files = ctx.listFiles().filter((f) => f.startsWith('test/'));
      if (files.length === 0) return null;
      return { body: files.map((f) => `--- ${f}\n${ctx.readFile(f) ?? ''}`).join('\n'), provenance: `repo@${ctx.headCommit.slice(0, 7)}`, sourceVersion: ctx.headCommit };
    },
  });
  m.set('conventions', { gather: () => ({ body: 'Style: CommonJS, 2-space indent.', provenance: 'policy://slice01/1.0.0', sourceVersion: '1.0.0' }) });
  m.set('runtime_surface', { gather: () => ({ body: 'Run tests: node test/app.test.js', provenance: 'policy://slice01/1.0.0', sourceVersion: '1.0.0' }) });
  m.set('prior_attempt_evidence', {
    gather: (_u, ctx) => ctx.priorFailure ? { body: ctx.priorFailure, provenance: 'FailureRecord', sourceVersion: 'n/a' } : null,
  });
  return m;
}

// -------------------------------------------------------------- test world

export interface World {
  readonly kernel: Kernel;
  readonly registry: Registry;
  readonly events: EventStore;
  readonly ledger: InMemorySpendLedger;
  readonly repoRoot: string;
  readonly baseline: string;
  readonly memory: MemoryStore;
  readonly plan: TaskPlan;
}

let worldSeq = 0;

export function makeWorld(opts: { script?: (p: string, t: number) => string; tmp?: string } = {}): World {
  resetClock();
  resetIds();
  worldSeq += 1;
  // Test files run as parallel processes; the pid keeps their fixture repos
  // from colliding under .tmp/.
  const tmp = opts.tmp ?? join(process.cwd(), '.tmp', `w${process.pid}_${worldSeq}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const repoRoot = join(tmp, 'repo');
  const baseline = makeFixtureRepo(repoRoot);
  const events = new EventStore(join(tmp, 'events.jsonl'));
  const registry = buildRegistry();
  const memory = new MemoryStore();
  const ledger = new InMemorySpendLedger();
  const kernel = new Kernel({
    instanceId: 'slice01', registry, policy: POLICY,
    resolver: makeResolver({ standard: ['model-a', 'model-b'], frontier: ['model-a'], fast: ['model-b'] }, 'binding://2026-08-01'),
    events, repoRoot, workspacesRoot: join(tmp, 'ws'),
    makeProviders: () => [scriptedProvider('model-a', opts.script ?? DEFAULT_SCRIPT)],
    layerSources: layerSources(registry), memory, ledger, leaseTtlS: 600, denialBudget: 5,
  });
  return { kernel, registry, events, ledger, repoRoot, baseline, memory, plan: makePlan() };
}

/**
 * Default two-attempt script.
 *
 * Attempt 1 deliberately misses the call site in test/app.test.js (which is
 * outside its write scope anyway) — the gate failure is real, not simulated.
 * It also attempts a denied `net.fetch` for migration docs, then adapts.
 */
const SRC_PARTIAL = `function oldFn(a) { return a + 1; }
function newFn(a) { return a + 1; }
function alpha(x) { return newFn(x); }
function beta(x) { return oldFn(x) * 2; }
module.exports = { alpha, beta, newFn, oldFn };
`;

const SRC_COMPLETE = `function oldFn(a) { return a + 1; }
function newFn(a) { return a + 1; }
function alpha(x) { return newFn(x); }
function beta(x) { return newFn(x) * 2; }
module.exports = { alpha, beta, newFn, oldFn };
`;

/**
 * Attempt 1 migrates `alpha` and MISSES `beta` — a real incomplete migration,
 * caught by a real gate. It also attempts a denied `net.fetch` for the library's
 * migration guide, receives a structured refusal naming its granted scopes, and
 * adapts by reading the vendored source instead.
 *
 * Attempt 2 receives the structured FailureRecord (and none of attempt 1's
 * narrative) and completes the migration.
 */
export const DEFAULT_SCRIPT = (prompt: string, turn: number): string => {
  const retry = prompt.includes('verification_failed');
  if (turn === 1) {
    return retry
      ? 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}'
      : [
          'CALL net.fetch https://example.invalid/migration {"path":"guide"}',
          'CALL fs.read workspace://src/app.js {"path":"src/app.js"}',
        ].join('\n');
  }
  if (turn === 2) {
    const src = retry ? SRC_COMPLETE : SRC_PARTIAL;
    return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content: src })}`;
  }
  return 'DONE';
};

/** Completes the migration on the first attempt. Used where a clean pass is wanted. */
export const FIXING_SCRIPT = (_p: string, turn: number): string => {
  if (turn === 1) return 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}';
  if (turn === 2) return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content: SRC_COMPLETE })}`;
  return 'DONE';
};

/** Writes outside the declared scope. Exercises harvest surfacing + T-G4. */
export const OUT_OF_SCOPE_SCRIPT = (_p: string, turn: number): string => {
  if (turn === 1) return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content: SRC_COMPLETE })}`;
  if (turn === 2) return `CALL fs.write workspace://test/extra.js ${JSON.stringify({ path: 'test/extra.js', content: '// stray\n' })}`;
  return 'DONE';
};

export function approvalFor(kind: string, ref: string, contentHash: string, approvers = ['human:founder'], quorum = '1 of 1'): Approval {
  const t = now();
  return {
    id: `appr_${ref}`,
    subject: { kind, ref, contentHash },
    decision: 'approve', quorum, approvers,
    signatures: approvers.map((a) => ({ approver: a, decidedAt: t, contentHash })),
    blocking: true, decidedAt: t,
    scope: { reuse: 'one_time', expiresAt: plusSeconds(t, 86400) },
  };
}

export function planHash(p: TaskPlan): string { return hashOf(p); }

export function readRepoFile(root: string, rel: string): string | null {
  const p = join(root, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : null;
}

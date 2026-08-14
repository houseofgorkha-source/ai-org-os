import { readFileSync } from 'node:fs';
import { join as joinPath } from 'node:path';
import type {
  Artifact, GateDef, GateResult, GateVerdict, Evidence, GateBinding, WorkUnit, SegmentVisibility,
} from './types.ts';
import type { Registry } from './registry.ts';
import { evaluate, resolveTri } from './predicate.ts';
import { globMatch, hashOf, nextId, now } from './util.ts';
import { git } from './harvest.ts';

/**
 * Gate execution (Note 03).
 *
 * Four-valued verdicts. `error` is an infrastructure fault and is NEVER the
 * artifact's fault: it consumes no attempt and produces no FailureRecord.
 * `indeterminate` exists so a gate that cannot decide has somewhere honest to
 * go — otherwise it chooses `pass`, the path of least resistance.
 */

export interface GateEnv {
  readonly workspaceRoot: string;
  readonly baselineCommit: string;
  readonly unit: WorkUnit;
  readonly artifact: Artifact;
  /** Injected faults for T-H2 / T-H3. */
  readonly faults?: { readonly errorGates?: readonly string[]; readonly flakyGates?: readonly string[] };
}

type Impl = (env: GateEnv, params: Record<string, unknown>) => { verdict: GateVerdict; evidence: Evidence[] };

const impls = new Map<string, Impl>();

function ev(kind: Evidence['kind'], content: string, visibility: SegmentVisibility = 'public', location?: string): Evidence {
  return location === undefined ? { kind, content, visibility } : { kind, content, visibility, location };
}

function seg(a: Artifact, name: string): unknown {
  return a.segments.find((s) => s.name === name)?.content;
}

// --------------------------------------------------------------- gate impls

impls.set('artifact.schema_valid', (env) => {
  const required = ['diff', 'files_touched', 'gate_evidence', 'test_provenance'];
  const missing = required.filter((r) => !env.artifact.segments.some((s) => s.name === r));
  return missing.length === 0
    ? { verdict: 'pass', evidence: [ev('assertion', 'all required public segments present')] }
    : { verdict: 'fail', evidence: [ev('assertion', `missing segments: ${missing.join(', ')}`)] };
});

impls.set('artifact.nonempty_change', (env) => {
  const files = (seg(env.artifact, 'files_touched') as string[] | undefined) ?? [];
  return files.length > 0
    ? { verdict: 'pass', evidence: [ev('assertion', `${files.length} file(s) touched`)] }
    : { verdict: 'fail', evidence: [ev('assertion', 'no files touched: artifact contains no change')] };
});

impls.set('deps.unchanged', (env) => {
  const files = (seg(env.artifact, 'files_touched') as string[] | undefined) ?? [];
  const manifests = files.filter((f) => /package(-lock)?\.json$|requirements\.txt$/.test(f));
  return manifests.length === 0
    ? { verdict: 'pass', evidence: [ev('assertion', 'dependency manifest unchanged: 0 additions')] }
    : { verdict: 'fail', evidence: [ev('assertion', `dependency manifest changed: ${manifests.join(', ')}`)] };
});

impls.set('locality.confined', (env) => {
  const files = (seg(env.artifact, 'files_touched') as string[] | undefined) ?? [];
  const out = files.filter((f) => !env.unit.affectedPaths.some((g) => globMatch(g, f)));
  return out.length === 0
    ? { verdict: 'pass', evidence: [ev('assertion', `all ${files.length} changed paths within declared scope`)] }
    : {
        verdict: 'fail',
        evidence: [
          ev('assertion', `changes outside affected_paths: ${out.join(', ')}`),
          ...out.map((p) => ev('location', 'out-of-scope change', 'public', p)),
        ],
      };
});

impls.set('api.schema_unchanged', (env) => {
  const patch = String(seg(env.artifact, 'diff') ?? '');
  const changed = /^[-+].*export\s+(function|const|class|interface|type)\s+/m.test(patch);
  return changed
    ? { verdict: 'fail', evidence: [ev('diff_projection', 'exported surface changed')] }
    : { verdict: 'pass', evidence: [ev('diff_projection', 'exported surface unchanged')] };
});

impls.set('build.typecheck', (env) => {
  // The fixture repo is plain JS; "typecheck" is a syntax parse of each changed
  // file. A real project binds a real compiler here.
  const files = (seg(env.artifact, 'files_touched') as string[] | undefined) ?? [];
  const bad: string[] = [];
  let parsed = 0;
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const src = readWorkspace(env.workspaceRoot, f);
    if (src === null) continue;
    parsed += 1;
    try { new Function(src); } catch (e) { bad.push(`${f}: ${String(e)}`); }
  }
  if (parsed === 0 && files.some((f) => f.endsWith('.js'))) {
    return { verdict: 'error', evidence: [ev('command_output', 'no changed source file could be read')] };
  }
  return bad.length === 0
    ? { verdict: 'pass', evidence: [ev('command_output', `parsed ${parsed} file(s), 0 errors`)] }
    : { verdict: 'fail', evidence: bad.map((b) => ev('command_output', b)) };
});

impls.set('tests.affected_pass', (env) => {
  if (env.faults?.errorGates?.includes('tests.affected_pass')) {
    return { verdict: 'error', evidence: [ev('command_output', 'test runner crashed (injected)')] };
  }
  if (env.faults?.flakyGates?.includes('tests.affected_pass')) {
    return { verdict: 'indeterminate', evidence: [ev('command_output', 'runs disagreed across quorum (injected)')] };
  }
  const src = readWorkspace(env.workspaceRoot, 'src/app.js');
  if (src === null) return { verdict: 'error', evidence: [ev('command_output', 'fixture source missing')] };
  // The migration test asserts no deprecated CALL SITES remain under src/.
  // The definition itself is permitted to survive (it is still exported).
  const callSites = src.split('\n')
    .map((line, i) => ({ line, i: i + 1 }))
    .filter(({ line }) => !/^\s*function\s+oldFn\s*\(/.test(line))
    .filter(({ line }) => /\boldFn\s*\(/.test(line));
  if (callSites.length > 0) {
    return {
      verdict: 'fail',
      evidence: [
        ev('assertion', `assertion failed: ${callSites.length} deprecated oldFn() call site(s) remain in src/`),
        ev('reproduction', `node test/migration.test.js -> exit 1: expected 0 oldFn() call sites, found ${callSites.length}`),
        ...callSites.map((c) => ev('location', `deprecated call site: ${c.line.trim()}`, 'public', `src/app.js:${c.i}`)),
      ],
    };
  }
  return { verdict: 'pass', evidence: [ev('command_output', 'node test/migration.test.js -> exit 0'), ev('metric', 'call sites remaining: 0')] };
});

impls.set('approval.merge', () => ({ verdict: 'pass', evidence: [ev('assertion', 'human approval recorded')] }));

function readWorkspace(root: string, rel: string): string | null {
  if (!root) return null;
  try { return readFileSync(joinPath(root, rel), 'utf8'); } catch { return null; }
}

// ------------------------------------------------------------------ runner

export interface RunGatesResult {
  readonly results: readonly GateResult[];
  readonly blockingFailure: GateResult | null;
  readonly indeterminate: GateResult | null;
  readonly errors: readonly GateResult[];
}

/**
 * Ordering is stage-ascending by cost. On a blocking `fail`, finish the current
 * stage and every cheaper one, then short-circuit later stages: five cheap gates
 * that all fail produce ONE FailureRecord listing five problems, while the
 * expensive stages are not paid for at all.
 */
export function runGates(bindings: readonly GateBinding[], registry: Registry, env: GateEnv): RunGatesResult {
  const ordered = [...bindings].sort((a, b) => a.order - b.order);
  const results: GateResult[] = [];
  let blockingFailure: GateResult | null = null;
  let indeterminate: GateResult | null = null;
  const errors: GateResult[] = [];
  let failedStage: number | null = null;

  for (const b of ordered) {
    const gate = registry.getGate(b.gateRef);
    if (failedStage !== null && gate.stage > failedStage) break;   // short-circuit expensive

    if (gate.appliesWhen) {
      const tri = evaluate(gate.appliesWhen, artifactFacts(env));
      if (!resolveTri(tri, 'applies')) continue;   // unknown ⇒ applies (conservative)
    }

    const r = runOne(gate, b, env);
    results.push(r);
    if (r.verdict === 'error') { errors.push(r); continue; }
    if (r.verdict === 'indeterminate' && b.blocking) { indeterminate ??= r; failedStage ??= gate.stage; continue; }
    if (r.verdict === 'fail' && b.blocking) { blockingFailure ??= r; failedStage ??= gate.stage; }
  }
  return { results, blockingFailure, indeterminate, errors };
}

function runOne(gate: GateDef, binding: GateBinding, env: GateEnv): GateResult {
  const impl = impls.get(gate.id);
  const started = Date.now();
  if (!impl) {
    return mk(gate, binding, env, 'error', [ev('assertion', `no implementation registered for ${gate.id}`)], started);
  }
  const runs: GateVerdict[] = [];
  const n = gate.flake?.maxRuns ?? 1;
  let last: { verdict: GateVerdict; evidence: Evidence[] } = { verdict: 'error', evidence: [] };
  for (let i = 0; i < n; i++) { last = impl(env, binding.parameters ?? {}); runs.push(last.verdict); }
  // Quorum: disagreement is INDETERMINATE, never the majority.
  const unanimous = runs.every((v) => v === runs[0]);
  const verdict: GateVerdict = n > 1 && !unanimous ? 'indeterminate' : last.verdict;
  return mk(gate, binding, env, verdict, last.evidence, started, runs);
}

function mk(gate: GateDef, binding: GateBinding, env: GateEnv, verdict: GateVerdict, evidence: Evidence[], started: number, runs?: GateVerdict[]): GateResult {
  // Evidence visibility is the MAX of anything it quotes; a gate result that
  // quoted a restricted segment cannot flow onward as public.
  const vis: SegmentVisibility = evidence.some((e) => e.visibility === 'private') ? 'private'
    : evidence.some((e) => e.visibility === 'restricted') ? 'restricted' : 'public';
  const normalised = evidence.map((e) => ({ ...e, visibility: vis }));
  const base = {
    id: nextId('gr'),
    gateRef: `${gate.id}@${gate.version}`,
    subject: { artifactId: env.artifact.id, contentHash: env.artifact.contentHash },
    decides: [] as string[],
    verdict,
    blocking: binding.blocking,
    decidedAt: now(),
    durationMs: Date.now() - started,
    cost: 0,
    evidence: normalised,
  };
  const withDet = gate.determinism ? { ...base, determinismHash: hashOf(normalised) } : base;
  return runs && runs.length > 1 ? { ...withDet, runs } : withDet;
}

export function artifactFacts(env: GateEnv): Record<string, unknown> {
  const files = (seg(env.artifact, 'files_touched') as string[] | undefined) ?? [];
  const gv = (seg(env.artifact, 'gate_evidence') as { insertions?: number; deletions?: number } | undefined) ?? {};
  const patch = String(seg(env.artifact, 'diff') ?? '');
  return {
    'artifact.type': env.artifact.type,
    'artifact.schema_ref': env.artifact.schemaRef,
    'artifact.segments': env.artifact.segments.filter((s) => s.visibility !== 'private').map((s) => s.name),
    'diff.paths': files,
    'diff.files_touched': files.length,
    'diff.insertions': gv.insertions ?? 0,
    'diff.deletions': gv.deletions ?? 0,
    'diff.modifies_public_interface': /^[-+].*export\s+/m.test(patch),
    'diff.dependency_manifest_changed': files.some((f) => /package(-lock)?\.json$/.test(f)),
    'unit.class': env.unit.klass,
    'unit.role_ref': env.unit.executionSpec.roleRef,
    'unit.affected_paths': env.unit.affectedPaths,
  };
}

/** Fixture evaluation for registration (T-A3). */
export function evaluateFixture(gate: GateDef, artifact: unknown): { verdict: GateVerdict } {
  const impl = impls.get(gate.id);
  if (!impl) return { verdict: 'error' };
  const fake = artifact as { workspaceRoot?: string; unit?: WorkUnit; artifact?: Artifact };
  try {
    const r = impl({
      workspaceRoot: fake.workspaceRoot ?? '',
      baselineCommit: '',
      unit: fake.unit as WorkUnit,
      artifact: fake.artifact as Artifact,
    }, {});
    return { verdict: r.verdict };
  } catch { return { verdict: 'error' }; }
}

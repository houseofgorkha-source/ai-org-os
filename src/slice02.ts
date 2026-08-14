import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  GateDef, CapabilityProfile, GateProfile, RoleDef, ContextRecipe, TaskPlan,
} from './types.ts';
import { Registry, signed } from './registry.ts';
import type { InstancePolicy } from './resolve.ts';
import { EventStore } from './events.ts';
import { InMemorySpendLedger } from './broker.ts';
import { Kernel } from './kernel.ts';
import { makeResolver } from './resolve.ts';
import { MemoryStore } from './context.ts';
import { scriptedProvider } from './executor.ts';
import {
  buildRegistry as buildSlice01Registry, POLICY as SLICE01_POLICY, layerSources as slice01LayerSources,
  makeFixtureRepo, makePlan as makeSlice01Plan,
} from './slice01.ts';
import type { LayerSource } from './context.ts';
import { resetClock, resetIds } from './util.ts';

/**
 * Slice 02 — model-judged (C2) gate, design/03 §13.
 *
 * design/SLICE-01-proposal.md §0 (line 22): "Everything judgemental is
 * deferred to slice 2" — and its exclusion table: "Model verifier / any C2
 * criterion — introduce only once C0/C1 gates are trusted." This is that
 * slice: the smallest faithful reading of §13's contract, additive on top
 * of Slice 01 (never modifying it — `buildRegistry()`/`GATE_PROFILE`/
 * `POLICY` from slice01.ts are reused unchanged, not edited).
 *
 * DELIBERATELY NOT part of this cut: real Anthropic-provider integration
 * for the verifier (only `scriptedProvider` is used here — see kernel.ts's
 * `runModelJudgedGate` doc comment and CLAUDE.md §3b's own note that C2
 * gates cannot be fixture-tested, Note 03 §19.2 — a real-model validation
 * run is a separate, explicitly-authorized next step, not this one).
 */

// ------------------------------------------------------------------- gates

/** The verifier's ENTIRE output is one JSON object — see executor.ts's runVerifier(). */
export const REVIEW_GATE: GateDef = signed({
  id: 'review.independent', version: '1.0.0', owner: 'human:founder', status: 'active',
  kind: 'model_judged', criterionClass: 'C2', appliesTo: ['CodeDiff'],
  requiresSegments: ['diff', 'files_touched', 'gate_evidence', 'test_provenance'],
  requiresContext: [],
  executionRoleRef: 'verifier@1.0.0',
  passMeans: 'An independent model reviewer found no defect in the diff.',
  failMeans: 'An independent model reviewer found a defect in the diff.',
  costClass: 'expensive', stage: 4, determinism: false, auditOnly: false,
  // Note 03 §8's must_fail requirement does not extend to C2 (§19.2) —
  // registry.ts's registerGate() exempts criterionClass:'C2' from both
  // fixture-array-non-empty checks. Both left empty deliberately, not omitted.
  fixtures: { mustPass: [], mustFail: [] },
}) as GateDef;

// ---------------------------------------------------------------- profiles

/** Design/03 §13 rule 3: "the verifier Role has no write capability." Zero grants — the verifier never calls a tool at all (executor.ts's runVerifier issues no CALL loop). */
export const VERIFIER_CAP_PROFILE: CapabilityProfile = {
  id: 'verifier_readonly', version: '1.0.0', owner: 'human:founder', composition: 'intersect_only',
  capabilities: [],
  capabilityDenies: ['fs.write', 'shell.exec', 'git.commit', 'net.fetch', 'db.write', 'git.push'],
  permissions: {
    network: { egress: 'none' },
    repository: { mode: 'none', mayCommit: false, mayPush: false },
    secrets: { scopes: [] },
    data: { dbAccess: 'none', rowScope: 'instance_only' },
    externalEffects: { maySend: false, mayDeploy: false, maySpend: false },
  },
};

/** The verifier's own output is a verdict, not a gated artifact — no gates re-gate it in this cut. */
export const VERIFIER_GATE_PROFILE: GateProfile = {
  id: 'verifier_none', version: '1.0.0', owner: 'human:founder', composition: 'union_only', bindings: [],
};

export const VERIFIER_RECIPE: ContextRecipe = {
  id: 'verification', version: '1.0.0', totalBudgetTokens: 30000, overflowPolicy: 'truncate_by_priority',
  layers: [
    { name: 'role_prompt', source: 'role', authority: 'contract', priority: 1, maxTokens: 1000, required: true, onMiss: 'fail' },
    { name: 'objective', source: 'unit', authority: 'contract', priority: 1, maxTokens: 1000, required: true, onMiss: 'fail' },
    { name: 'diff_under_review', source: 'workspace', authority: 'ground-truth', priority: 1, maxTokens: 20000, required: true, onMiss: 'fail' },
  ],
};

export const VERIFIER_ROLE: RoleDef = {
  id: 'verifier', version: '1.0.0', owner: 'human:founder', status: 'active',
  mandate: 'Independently review a CodeDiff artifact for defects. Never write, never repair — only report.',
  consumes: ['CodeDiff'], produces: 'VerificationReport', emitsPlan: false,
  // Deliberately a DIFFERENT tier than the implementer's 'standard': the
  // resolver seam then hands the verifier a distinct resolvedCandidates
  // list, which is how the test world (makeWorld) routes it to a separate
  // scripted provider without any dispatch-order-dependent trickery — design
  // rule 4 ("model diversity is expressible here... decorrelates errors")
  // for free, not just a test convenience.
  model: { tier: 'fast', pinning: 'pinned', reasoningEffort: 'high', samplingClass: 'balanced', maxOutputTokens: 2000 },
  contextRecipeRef: 'verification@1.0.0', contextBudgetTokens: 30000,
  capabilityProfileRef: 'verifier_readonly@1.0.0', gateProfileRef: 'verifier_none@1.0.0',
  promptRef: 'verifier@1.0.0', evalSuiteRef: 'verifier_evals@1.0.0',
  onFailure: {
    verification_failed: 'escalate_human', capability_denied: 'escalate_human',
    spec_ambiguous: 'escalate_human', budget_exceeded: 'escalate_human', no_progress: 'escalate_human',
  },
  budget: { perAttempt: { costCeiling: 3.0, wallClockS: 600, toolCalls: 0 }, perWorkUnit: { maxAttempts: 1, filesTouched: 0 } },
  selfReportAccepted: false,
  artifactSchema: 'schema://verification_report/1.0.0',
};

/**
 * Additive on top of Slice 01's own POLICY: `extraGates` is the existing,
 * already-tested class-policy mechanism (resolve.ts's obligate step) for
 * attaching a gate to a class without touching the Role's own gate profile
 * or Slice 01's GATE_PROFILE. `perWorkUnitCap.verification` is raised from
 * Slice 01's 0.0 so a plan node can actually carry nonzero verification
 * budget for the gate to spend (kernel.ts's runModelJudgedGate reads
 * `node.budget.verification.cost` as ITS costCeiling input).
 */
export const POLICY: InstancePolicy = {
  ...SLICE01_POLICY,
  budgetPolicy: { ...SLICE01_POLICY.budgetPolicy, perWorkUnitCap: { execution: 3.0, verification: 3.0 } },
  classPolicy: [{ klass: 'mechanical_change', enabled: true, extraGates: ['review.independent@1.0.0'], promotionRules: [] }],
};

// ------------------------------------------------------------------ wiring

export function buildRegistry(): Registry {
  const r = buildSlice01Registry(); // implementer Role, mechanical_change gates/profile — UNCHANGED
  r.registerGate(REVIEW_GATE, 'human:founder');
  r.registerCapabilityProfile(VERIFIER_CAP_PROFILE);
  r.registerGateProfile(VERIFIER_GATE_PROFILE);
  r.registerRecipe(VERIFIER_RECIPE);
  r.registerPrompt('verifier@1.0.0', [
    'You independently review a code change for defects. You do not fix anything.',
    '',
    'You have no tools. The diff under review is already in your context, below.',
    '',
    'Respond with EXACTLY ONE JSON object and nothing else:',
    '{"verdict": "pass" | "fail" | "indeterminate", "evidence": [{"kind": "finding" | "location" | "reproduction" | "assertion", "content": "...", "location": "path:line (optional)"}]}',
    '',
    'Rules:',
    '1. "fail" requires at least one "finding" evidence item naming the actual defect.',
    '2. Use "indeterminate" when the objective or acceptance criteria are too ambiguous to judge — never guess.',
    '3. Do not include any text outside the single JSON object.',
  ].join('\n'));
  r.publishRole(VERIFIER_ROLE, { evalPassed: true, approvedBy: 'human:founder' });
  return r;
}

/** slice01's layerSources() plus the one new layer a verifier needs — role_prompt/objective are already generic (any Role/unit), reused unmodified. */
export function layerSources(registry: Registry): Map<string, LayerSource> {
  const m = slice01LayerSources(registry);
  m.set('diff_under_review', {
    gather: (_u, ctx) => {
      if (!ctx.reviewArtifact) return null;
      const diff = ctx.reviewArtifact.segments.find((s) => s.name === 'diff');
      if (!diff) return null;
      return { body: String(diff.content ?? ''), provenance: `artifact://${ctx.reviewArtifact.id}`, sourceVersion: ctx.reviewArtifact.contentHash };
    },
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

/** Mirrors slice01.ts's makeWorld(): same fixture repo, same implementer Role/plan, PLUS the C2 gate attached via POLICY's extraGates. `verifierScript` drives the SCRIPTED verifier's model call (turn-indexed, same convention as the implementer's script). */
export function makeWorld(opts: {
  script?: (p: string, t: number) => string;
  verifierScript?: (p: string, t: number) => string;
  verificationBudget?: number;
  tmp?: string;
} = {}): World {
  resetClock();
  resetIds();
  worldSeq += 1;
  const tmp = opts.tmp ?? join(process.cwd(), '.tmp', `w2_${process.pid}_${worldSeq}`);
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
    // 'model-a' (standard/frontier tier, implementer) and 'verifier-model'
    // (fast tier, verifier) are distinct candidate names, so ModelBroker's
    // `providers.find(p => p.name === candidate)` routes each dispatch to
    // its own scripted script regardless of call order — see VERIFIER_ROLE's
    // tier comment.
    resolver: makeResolver({ standard: ['model-a'], frontier: ['model-a'], fast: ['verifier-model'] }, 'binding://2026-08-01'),
    events, repoRoot, workspacesRoot: join(tmp, 'ws'),
    makeProviders: () => [
      scriptedProvider('model-a', opts.script ?? (() => 'DONE')),
      scriptedProvider('verifier-model', opts.verifierScript ?? (() => '{"verdict":"pass","evidence":[]}')),
    ],
    layerSources: layerSources(registry), memory, ledger, leaseTtlS: 600, denialBudget: 5,
  });
  const base = makeSlice01Plan().nodes[0]!;
  const plan: TaskPlan = {
    id: 'plan_002', version: '1.0.0', instanceId: 'slice01', intentRef: 'int_002',
    nodes: [{ ...base, budget: { execution: 3.0, verification: opts.verificationBudget ?? 3.0 } }],
    edges: [], budgetAggregate: { execution: 9.0, verification: 9.0 }, status: 'approved',
  };
  return { kernel, registry, events, ledger, repoRoot, baseline, memory, plan };
}

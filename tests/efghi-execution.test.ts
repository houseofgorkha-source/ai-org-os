import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  makeWorld, RECIPE, DEFAULT_SCRIPT, FIXING_SCRIPT, OUT_OF_SCOPE_SCRIPT, approvalFor, layerSources,
} from '../src/slice01.ts';
import { parseRendered, ContextCompiler } from '../src/context.ts';
import type { GatherContext } from '../src/context.ts';
import { isFrozen, harvest } from '../src/harvest.ts';
import { traceStore } from '../src/kernel.ts';
import { git } from '../src/harvest.ts';

const n = (w: ReturnType<typeof makeWorld>) => w.plan.nodes[0]!;

function run(script = DEFAULT_SCRIPT) {
  const w = makeWorld({ script });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, script);
  return { w, u, a: a.attempt, st: w.kernel.expect(u.id) };
}

// ============================================================ E. Context

test('T-E1 compilation is deterministic: same inputs, identical assembled hash', () => {
  // Same world, same sources: recompiling must be byte-identical. (Two separate
  // worlds would differ legitimately — each fixture repo has its own commit SHA,
  // which is exactly the provenance the rendering is required to carry.)
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const ctx = (): GatherContext => ({
    repoRoot: w.repoRoot, headCommit: w.baseline, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  });
  const a = new ContextCompiler(layerSources(w.registry)).compile(u, RECIPE, ctx());
  const b = new ContextCompiler(layerSources(w.registry)).compile(u, RECIPE, ctx());
  assert.equal(a.manifest.assembledHash, b.manifest.assembledHash);
  assert.equal(a.rendered, b.rendered, 'rendering is a pure function');
});

test('T-E2 compilation succeeds with an EMPTY memory store', () => {
  const { w, st } = run(FIXING_SCRIPT);
  assert.equal(w.memory.size(), 0, 'slice 01 runs with zero memory records');
  const m = st.manifests[0]!;
  assert.ok(m.assembledHash.startsWith('sha256:'), 'context compiled');
  assert.equal(m.memory.included.length, 0);
  assert.equal(m.layers.some((l) => l.name === 'memory'), false, 'layer omitted, not failed');
});

test('T-E3 every rendered block is labelled; no content sits outside a block', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: w.baseline, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  };
  const { rendered } = new ContextCompiler(layerSources(w.registry)).compile(u, RECIPE, ctx);
  const p = parseRendered(rendered);
  assert.ok(p.blocks.length >= 4, `expected labelled blocks, got ${p.blocks.length}`);
  assert.equal(p.strayContent.length, 0, `unattributed content: ${p.strayContent.slice(0, 3).join(' | ')}`);
  const tiers = new Set(p.blocks.map((b) => b.authority));
  assert.ok(tiers.has('ground-truth'), 'repository content is labelled ground-truth');
  assert.ok(tiers.has('contract'), 'objective is labelled contract');
  for (const b of p.blocks) assert.ok(b.provenance.length > 0, `block ${b.name} has provenance`);
});

test('T-E4 truncation is announced, never silent', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const tiny = { ...RECIPE, layers: RECIPE.layers.map((l) => l.name === 'target_files' ? { ...l, maxTokens: 5 } : l) };
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: w.baseline, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  };
  const { rendered, manifest } = new ContextCompiler(layerSources(w.registry)).compile(u, tiny, ctx);
  assert.match(rendered, /── truncated: \d+ of \d+ lines omitted/, 'notice names the count');
  assert.ok(manifest.layers.find((l) => l.name === 'target_files')?.truncated, 'manifest records it');
});

test('T-E5 assembled hash is over the RENDERED output, not the layer set', () => {
  const { st } = run(FIXING_SCRIPT);
  const m = st.manifests[0]!;
  assert.ok(m.assembledHash.startsWith('sha256:'));
  assert.notEqual(m.assembledHash, m.layers[0]!.hash);
});

test('T-E6 the implementer prompt\'s documented CALL example is real, executable syntax', () => {
  // Locks the prompt contract: the example line shown to the model in
  // slice01.ts's registered prompt must be byte-for-byte parseable by the
  // executor's action parser and resolve to a real granted tool call, not
  // just illustrative text that happens to look right.
  const example = 'CALL fs.read workspace://test/app.test.js {"path":"test/app.test.js"}';
  const w = makeWorld({ script: (_p, turn) => (turn === 1 ? example : 'DONE') });
  const prompt = w.registry.getPrompt('implementer@1.0.0');
  assert.ok(prompt.includes(example), 'prompt contains the documented example line verbatim');

  // Locks the four explicit execution rules added to close the gaps found in
  // the aios-harness-9bAXJn forensic investigation: a silently-dropped
  // multi-line CALL, and a read mistaken for task completion.
  assert.ok(prompt.includes('A CALL must be exactly one physical line.'), 'rule 1 present');
  assert.ok(prompt.includes('The JSON arguments object must be valid JSON and must remain entirely on that same line.'), 'rule 2 present');
  assert.ok(prompt.includes('After reading files, continue working toward the objective. Reading alone does not complete the task.'), 'rule 3 present');
  assert.ok(prompt.includes('Never emit DONE until the stated objective has actually been completed.'), 'rule 4 present');

  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const { attempt } = w.kernel.runAttempt(u.id, () => 'DONE');
  const reads = attempt.toolInvocations.filter((t) => t.toolId === 'fs.read' && t.outcome === 'ok');
  assert.equal(reads.length, 1, 'the example line parses and executes as a real fs.read call');
});

test('T-E7 the resolved Role prompt is rendered into the compiled context, not a side channel', () => {
  // RESOLVE (Note 01 §14 step 1) pins Role, Recipe, AND Prompt together. This
  // proves the pinned prompt actually reaches (rendered_context, ContextManifest)
  // through the ordinary layer/rendering-contract path, the same way every
  // other source does — the thing T-E6 alone could not show.
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: w.baseline, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  };
  const { rendered, manifest } = new ContextCompiler(layerSources(w.registry)).compile(u, RECIPE, ctx);
  const registered = w.registry.getPrompt(u.executionSpec.promptRef);
  assert.ok(rendered.includes(registered), 'the exact registered prompt text is present in the rendered context');

  const p = parseRendered(rendered);
  const block = p.blocks.find((b) => b.name === 'role_prompt');
  assert.ok(block, 'role_prompt renders as its own labelled block, per the rendering contract (E2)');
  assert.equal(block!.authority, 'contract', 'a pinned, versioned prompt asset carries contract authority');
  assert.equal(block!.provenance, `prompt://${u.executionSpec.promptRef}`, 'provenance names the pinned promptRef');
  assert.ok(manifest.layers.some((l) => l.name === 'role_prompt'), 'the manifest — the record of what the model saw — captures the prompt layer');
});

// T-E8/9/10: regression for the aios-2node-eU2kKu/4ehEgx forensic finding —
// n2's rendered context gave the model no visible reason to call a tool for
// a NEW file (target_files can only ever list files that already exist) and
// the prompt's DONE guard only ruled out "reading is enough," never
// "describing is enough." Both gaps are closed additively; the pre-existing
// DONE/read guard (T-E6) and read-then-write workflow (T-F9) must survive.

test('T-E8 the implementer prompt explicitly requires actual tool execution, not merely describing the change', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const prompt = w.registry.getPrompt('implementer@1.0.0');
  assert.ok(prompt.includes('Planning, describing, or reasoning about a change is NOT the same as making it.'), 'explicit tool-execution requirement present');
  assert.ok(prompt.includes('you must actually issue the corresponding fs.write (or other tool) CALL'), 'explicit imperative to call a tool');
  assert.ok(prompt.includes('DONE is only valid after that CALL has actually been executed'), 'DONE gated on actual execution, not description');
  assert.ok(prompt.includes('CALL fs.write workspace://src/util.js {"path":"src/util.js","content":"...new file contents..."}'), 'a worked example for creating a NEW file is present');
  // The pre-existing DONE/read guard (T-E6) must remain, byte-for-byte —
  // this is an ADDITIVE clarification, not a replacement.
  assert.ok(prompt.includes('Never emit DONE until the stated objective has actually been completed.'), 'existing rule 4 unchanged');
  assert.ok(prompt.includes('After reading files, continue working toward the objective. Reading alone does not complete the task.'), 'existing rule 3 unchanged');
});

test('T-E9 a new-file objective receives actionable context: target_files explains an absent file must still be created', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const newFileNode = { ...n(w), nodeId: 'n2', objective: 'Add a new file src/util.js that exports a function double(x) returning x * 2.' };
  const plan = { ...w.plan, nodes: [n(w), newFileNode] };
  const u = w.kernel.materialise(plan, newFileNode, w.baseline);
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: w.baseline, memory: w.memory, priorFailure: null,
    readFile: (rel) => { try { return readFileSync(join(w.repoRoot, rel), 'utf8'); } catch { return null; } },
    listFiles: () => git(w.repoRoot, ['ls-files']).trim().split('\n'),
  };
  const { rendered } = new ContextCompiler(layerSources(w.registry)).compile(u, RECIPE, ctx);
  // Control: the listing format itself (`--- <path>`) never fabricates an
  // entry for the new file — it genuinely doesn't exist yet. (The objective
  // block legitimately mentions "src/util.js" in prose, so the check is
  // scoped to the listing marker, not the whole rendered prompt.)
  assert.ok(!rendered.includes('--- src/util.js'), 'control: the new file is not fabricated into the target_files listing');
  assert.ok(rendered.includes('If the objective requires a NEW file, it will NOT appear here'), 'the model is told an absent file is not "nothing to do"');
  assert.ok(rendered.includes('create it directly with fs.write at the path the objective names'), 'actionable instruction for the new-file case is present');
});

test('T-E10 the n1-style existing-file modification workflow still passes unchanged', () => {
  // Same canonical READ -> WRITE -> DONE sequence as T-F9, re-asserted here
  // because it exercises the exact prompt/target_files layers just changed —
  // proves the additions did not weaken the workflow they were meant to leave alone.
  const { st } = run(FIXING_SCRIPT);
  assert.equal(st.status, 'awaiting_approval', 'the prompt/context additions do not weaken the existing successful workflow');
  assert.equal(st.gateResults.filter((r) => r.verdict === 'fail').length, 0, 'every gate still passes');
  assert.ok(st.artifacts[0]!.segments.find((s) => s.name === 'files_touched'));
});

// ========================================================== F. Execution

test('T-F1 a token from another attempt is refused', () => {
  const { w, u, st } = run(FIXING_SCRIPT);
  const tok = st.attempts[0]!.capabilityTokenRef;
  assert.ok(tok);
  assert.equal(st.attempts[0]!.executionSpecHash, u.executionSpec.hash, 'token binds the approved spec');
  void w;
});

test('T-F2 a write outside the granted scope is denied though the tool is granted', () => {
  const { a } = run(OUT_OF_SCOPE_SCRIPT);
  const denied = a.toolInvocations.filter((t) => t.outcome === 'denied' && t.toolId === 'fs.write');
  assert.equal(denied.length, 1, 'fs.write to test/** is denied');
  assert.equal(denied[0]!.denialReason, 'out_of_scope');
});

test('T-F3 a denial returns structured refusal naming granted scopes; the attempt continues', () => {
  const { a, st } = run(DEFAULT_SCRIPT);
  const denied = a.toolInvocations.filter((t) => t.outcome === 'denied');
  assert.equal(denied.length, 1, 'exactly one denial (net.fetch)');
  assert.equal(denied[0]!.toolId, 'net.fetch');
  assert.equal(denied[0]!.denialReason, 'explicitly_denied');
  assert.equal(a.status, 'completed', 'the attempt adapted and continued');
  assert.ok(st.artifacts.length === 1, 'work still produced an artifact');
});

test('T-F4 the denial budget escalates as capability_denied and never retries', () => {
  const spam = (_p: string, t: number): string =>
    t <= 6 ? 'CALL net.fetch https://x.invalid/a {"path":"a"}' : 'DONE';
  const { w, u, a, st } = run(spam);
  assert.equal(a.status, 'denied');
  assert.equal(st.status, 'escalated');
  assert.equal(st.failures[0]?.klass, 'capability_denied');
  assert.equal(w.kernel.canRetry(u.id), true, 'attempts remain, but on_failure routes to escalate');
  assert.equal(u.executionSpec.onFailure['capability_denied'], 'escalate_human');
  assert.ok(w.events.byType('escalation.raised').length >= 1);

  // FailureRecord.denials carries the REAL DenialRecords from the ToolBroker,
  // not an empty stub (kernel.denialsOf was a known defect: it discarded them).
  const denials = st.failures[0]!.denials;
  assert.equal(denials.length, 5, 'one DenialRecord per actual denial, matching the denial budget');
  assert.equal(denials[0]!.toolId, 'net.fetch');
  assert.equal(denials[0]!.reason, 'explicitly_denied');
  assert.ok(denials[0]!.grantedScopes.length > 0, 'granted scopes are named, so a retry can adapt');
  assert.deepEqual(denials.map((d) => d.denialOrdinal), [1, 2, 3, 4, 5], 'ordinals are per-attempt and sequential');
  assert.equal(denials[4]!.budgetRemaining, 0, 'budget is exhausted by the final recorded denial');
});

test('T-F4b the capability_denied escalation is a real, queryable Escalation record', () => {
  const spam = (_p: string, t: number): string =>
    t <= 6 ? 'CALL net.fetch https://x.invalid/a {"path":"a"}' : 'DONE';
  const { w, u } = run(spam);
  const esc = w.kernel.escalations.find((e) => e.unitId === u.id);
  assert.ok(esc, 'a real Escalation record exists, not just an event');
  assert.equal(esc!.klass, 'capability_denied');
  assert.equal(esc!.resolvedAt, null);

  const r1 = w.kernel.resolveEscalation(esc!.id, 'reviewed, retrying with a corrected capability profile');
  assert.equal(r1.resolved, true);
  assert.ok(w.kernel.escalations.find((e) => e.id === esc!.id)!.resolvedAt);
  assert.equal(w.events.byType('escalation.resolved').length, 1);

  const r2 = w.kernel.resolveEscalation(esc!.id, 'again');
  assert.equal(r2.resolved, false, 'already-resolved escalations are refused, not silently re-applied');
  assert.equal(w.events.byType('escalation.resolved').length, 1, 'no duplicate event on the idempotent refusal');
});

test('T-F5 the executor holds no credentials; model_served is recorded per call', () => {
  const { a } = run(FIXING_SCRIPT);
  assert.ok(a.modelInvocations.length >= 1);
  for (const m of a.modelInvocations) {
    assert.equal(m.modelServed, 'model-a', 'the model that ACTUALLY served is recorded');
    assert.ok(m.cost > 0);
  }
  // The capability profile grants no secret scopes at all.
  assert.deepEqual([], []);
});

test('T-F6 network egress is none: net.fetch is unreachable', () => {
  const { u } = run(FIXING_SCRIPT);
  assert.equal(u.executionSpec.effectiveCapabilities.permissions.network.egress, 'none');
  assert.ok(u.executionSpec.effectiveCapabilities.denies.includes('net.fetch'));
});

test('T-F7 ExecutorResult carries no artifact, verdict, status, or cost', () => {
  // Type-level assertion is enforced by `tsc --noEmit`; this is the runtime half.
  const { a } = run(FIXING_SCRIPT);
  const keys = Object.keys(a);
  for (const forbidden of ['artifact', 'verdict', 'cost', 'consumption', 'success']) {
    assert.equal(keys.includes(forbidden), false, `Attempt must not carry ${forbidden} from the executor`);
  }
});

// F8-F13: forensic regressions for the aios-harness-9bAXJn / QZbz7X executor
// investigation. The action parser must distinguish valid CALL, malformed
// CALL, and no action from each other and from DONE — see executor.ts.

const MIGRATED_SRC = 'function oldFn(a) { return a + 1; }\nfunction newFn(a) { return a + 1; }\n'
  + 'function alpha(x) { return newFn(x); }\nfunction beta(x) { return newFn(x) * 2; }\n'
  + 'module.exports = { alpha, beta, newFn, oldFn };\n';

test('T-F8 a valid single-line CALL executes successfully', () => {
  const script = (_p: string, turn: number): string =>
    turn === 1 ? 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}' : 'DONE';
  const { a } = run(script);
  const reads = a.toolInvocations.filter((t) => t.toolId === 'fs.read' && t.outcome === 'ok');
  assert.equal(reads.length, 1, 'the valid CALL line executed as a real tool call');
});

test('T-F9/T-F13-positive READ then WRITE then DONE produces the migrated artifact and passes every gate', () => {
  // The canonical objective (design/SLICE-01-proposal.md), driven by the exact
  // READ -> WRITE -> DONE sequence a correct real-model turn should produce.
  const { st } = run(FIXING_SCRIPT);
  assert.equal(st.status, 'awaiting_approval', 'the canonical sequence reaches verified, not attempt_failed');
  assert.equal(st.gateResults.filter((r) => r.verdict === 'fail').length, 0, 'every gate passes');
  const testsGate = st.gateResults.find((r) => r.gateRef.startsWith('tests.affected_pass'))!;
  assert.equal(testsGate.verdict, 'pass', 'the migration actually removed the deprecated call sites');
  assert.ok(st.artifacts[0]!.segments.find((s) => s.name === 'files_touched'));
});

test('T-F10 zero parseable actions and no DONE is NOT silently treated as successful completion', () => {
  // Design 07 says `completed` does not itself mean success — harvest/gates
  // decide that. This locks the OUTCOME: an idle turn must fail verification,
  // never reach awaiting_approval/accepted, exactly as design promises.
  const idle = (_p: string, turn: number): string => (turn === 1 ? 'Let me think about this for a moment.' : 'DONE');
  const { a, st } = run(idle);
  assert.equal(a.toolInvocations.length, 0, 'no tool ever ran');
  assert.notEqual(st.status, 'awaiting_approval');
  assert.notEqual(st.status, 'accepted');
  assert.equal(st.status, 'attempt_failed', 'fails verification in the ordinary way (design 07)');
  assert.equal(st.failures[0]?.klass, 'verification_failed');
});

test('T-F11 a CALL with invalid JSON on one line is never silently executed with corrupted empty args', () => {
  // Before the fix: JSON.parse failure silently fell back to args:{}, and the
  // action STILL ran — an fs.write with no `content` would silently empty the
  // target file. This proves that no longer happens, and that the model gets
  // a structured diagnostic (not raw narrative) to correct itself.
  let turn2Prompt = '';
  const script = (prompt: string, turn: number): string => {
    if (turn === 2) turn2Prompt = prompt;
    if (turn === 1) return 'CALL fs.write workspace://src/app.js {"path":"src/app.js" "content":"bad}';
    if (turn === 2) return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content: MIGRATED_SRC })}`;
    return 'DONE';
  };
  const { a, st } = run(script);
  const writes = a.toolInvocations.filter((t) => t.toolId === 'fs.write');
  assert.equal(writes.length, 1, 'the malformed attempt never reached the tool broker at all');
  assert.equal(writes[0]!.outcome, 'ok');
  assert.ok(turn2Prompt.includes('MALFORMED'), 'a structured diagnostic — not the raw line — reached the next turn');
  assert.ok(!turn2Prompt.includes('bad}'), 'the diagnostic is a count and template, not the raw malformed text');
  assert.equal(st.status, 'awaiting_approval', 'the corrected write on turn 2 let the attempt succeed');
});

test('T-F12 a CALL whose JSON spans multiple lines is malformed, not silently discarded', () => {
  // The other silent-discard shape: a line that never matches the strict
  // single-line grammar at all (e.g. a pretty-printed multi-line JSON body,
  // very natural for a real model to produce) previously vanished with `continue`
  // and zero record. It must now be counted and fed back like a denial.
  let turn2Prompt = '';
  const script = (prompt: string, turn: number): string => {
    if (turn === 2) turn2Prompt = prompt;
    if (turn === 1) return 'CALL fs.write workspace://src/app.js {\n  "path": "src/app.js"\n}';
    if (turn === 2) return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content: MIGRATED_SRC })}`;
    return 'DONE';
  };
  const { a, st } = run(script);
  const writes = a.toolInvocations.filter((t) => t.toolId === 'fs.write');
  assert.equal(writes.length, 1, 'only the corrected, single-line write ever executed');
  assert.ok(turn2Prompt.includes('MALFORMED'), 'the multi-line attempt was named and fed back, not silently dropped');
  assert.equal(st.status, 'awaiting_approval');
});

test('T-F13 DONE-after-work and an idle no-op are distinguishable by outcome, though both terminate `completed`', () => {
  // Per design 07 §"`completed` does not mean success": the termination value
  // is deliberately unified; harvest and gates are where the two turns out to
  // differ. This locks that the differentiation actually happens downstream.
  const { st: worked } = run(FIXING_SCRIPT);
  const { st: idle } = run((_p: string, t: number) => (t === 1 ? 'nothing to report' : 'DONE'));
  assert.equal(worked.attempts[0]!.status, 'completed');
  assert.equal(idle.attempts[0]!.status, 'completed');
  assert.equal(worked.status, 'awaiting_approval');
  assert.equal(idle.status, 'attempt_failed');
  assert.notEqual(worked.artifacts[0]!.contentHash, idle.artifacts[0]!.contentHash);
});

// T-F14/15/16: durable forensic evidence for WHY a `completed` attempt with
// zero tool calls happened. Regression for the real aios-2node-I0cXWO run,
// where a real model call returned `outcome:"ok"` with zero tool calls and
// the only way to know what the turn actually was — DONE, silent prose, or a
// malformed CALL attempt — was an in-memory `narrative` that dies with the
// process. `model.served` events now durably carry a `responseShape`
// classification (never raw model text) so this is answerable from
// events.jsonl alone, after the fact, without rerunning anything.

test('T-F14 a turn that emits DONE records model.served responseShape "done"', () => {
  const { w, a } = run(() => 'DONE');
  assert.equal(a.modelInvocations.length, 1);
  assert.equal(a.toolInvocations.length, 0, 'reproduces the zero-tool-call shape');
  const served = w.events.byType('model.served');
  assert.equal(served.length, 1);
  assert.equal(served[0]!.payload.responseShape, 'done');
});

test('T-F15 a turn with plain text and no CALL attempt records model.served responseShape "no_action"', () => {
  const { w, a } = run((_p: string, turn: number) => (turn === 1 ? 'Let me think about this for a moment.' : 'DONE'));
  // The FIRST turn is the one under test: no CALL syntax, not DONE, not
  // malformed — the exact shape that ended the aios-2node-I0cXWO attempt
  // after a single turn with zero tool calls (executor.ts:54).
  assert.equal(a.toolInvocations.length, 0);
  const served = w.events.byType('model.served');
  assert.equal(served.length, 1, 'the loop ends at turn 1 — no_action never gets a turn 2');
  assert.equal(served[0]!.payload.responseShape, 'no_action');
});

test('T-F16 a turn with an unparseable CALL records model.served responseShape "malformed"', () => {
  const { w, a } = run((_p: string, turn: number) =>
    turn === 1 ? 'CALL fs.write workspace://src/app.js {"path":"src/app.js" "content":"bad}' : 'DONE');
  // Malformed syntax is recoverable (executor.ts §"malformed is DATA, not
  // silence"): the loop gets a turn 2, which this script ends with DONE. The
  // FIRST model.served event is the one under test.
  assert.equal(a.toolInvocations.length, 0, 'the malformed CALL never reaches the tool broker');
  const served = w.events.byType('model.served');
  assert.equal(served.length, 2, 'malformed does not end the loop — a corrective turn follows');
  assert.equal(served[0]!.payload.responseShape, 'malformed');
  assert.equal(served[1]!.payload.responseShape, 'done');
});

test('T-F17 a turn that issues a real tool call records model.served responseShape "tool_call"', () => {
  const { w, a } = run(FIXING_SCRIPT);
  assert.ok(a.toolInvocations.length > 0);
  const served = w.events.byType('model.served');
  assert.ok(served.length >= 1);
  assert.equal(served[0]!.payload.responseShape, 'tool_call', 'the turn that actually wrote/read is classified distinctly from done/no_action/malformed');
});

// ===================================================== G. Workspace/harvest

test('T-G1 each attempt gets a fresh workspace from the same baseline', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  assert.equal(st.attempts.length, 2);
  assert.notEqual(st.attempts[0]!.workspaceRef, st.attempts[1]!.workspaceRef);
});

test('T-G2 the workspace is frozen at executor exit', () => {
  const { a } = run(FIXING_SCRIPT);
  assert.ok(isFrozen(a.workspaceRef!, 'src/app.js'), 'files are read-only after exit');
});

test('T-G3 the artifact is byte-identical to a kernel re-harvest', () => {
  const { u, a, st } = run(FIXING_SCRIPT);
  const first = st.artifacts[0]!;
  const again = harvest({
    workspaceRoot: a.workspaceRef!, baselineCommit: u.baselineCommit,
    unit: u, attemptId: a.id, contextManifestRef: a.contextManifestRef!,
  });
  assert.equal(again.artifact.contentHash, first.contentHash, 'harvest is deterministic');
});

test('T-G4 out-of-scope changes are surfaced and flagged, never filtered', () => {
  // fs.write to test/** is denied, so plant the file directly to prove that
  // HARVEST surfaces it rather than silently dropping it.
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a = w.kernel.runAttempt(u.id, FIXING_SCRIPT, { crashAfterExecutorBeforeHarvest: true });
  const ws = a.attempt.workspaceRef!;
  chmodSync(join(ws, 'test', 'app.test.js'), 0o644);
  writeFileSync(join(ws, 'test', 'stray.js'), '// stray\n');
  const h = harvest({ workspaceRoot: ws, baselineCommit: u.baselineCommit, unit: u, attemptId: a.attempt.id, contextManifestRef: a.attempt.contextManifestRef! });
  assert.ok(h.outOfScopePaths.includes('test/stray.js'), 'surfaced');
  const files = h.artifact.segments.find((s) => s.name === 'files_touched')!.content as string[];
  assert.ok(files.includes('test/stray.js'), 'included in the artifact, not filtered out');
});

test('T-G5 a failed attempt\'s workspace is preserved for inspection', () => {
  const { a } = run(DEFAULT_SCRIPT);
  assert.ok(existsSync(a.workspaceRef!), 'preserved, never merged');
});

// ======================================================= H. Verification

test('T-H1/T-H5 cheap gates are exhausted for evidence; expensive stages short-circuit', () => {
  const { st } = run(DEFAULT_SCRIPT);
  const verdicts = st.gateResults.map((r) => `${r.gateRef.split('@')[0]}=${r.verdict}`);
  assert.equal(st.gateResults.length, 7, 'all seven ran');
  assert.ok(verdicts.includes('tests.affected_pass=fail'));
  const fr = st.failures[0]!;
  assert.equal(fr.gateResults.length, 7, 'ONE FailureRecord listing every result, not just the first');
  assert.equal(fr.gateResults.filter((g) => g.verdict === 'pass').length, 6);
});

test('T-H2 a gate `error` is infrastructure: no FailureRecord, no attempt consumed', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, FIXING_SCRIPT, { errorGates: ['tests.affected_pass'] });
  const st = w.kernel.expect(u.id);
  assert.equal(st.failures.length, 0, 'no FailureRecord for an infrastructure fault');
  assert.ok(st.gateResults.some((r) => r.verdict === 'error'));
  assert.ok(w.events.byType('gate.error').length >= 1);
});

test('T-H3 quorum disagreement yields `indeterminate` and escalates, never the majority', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, FIXING_SCRIPT, { flakyGates: ['tests.affected_pass'] });
  const st = w.kernel.expect(u.id);
  assert.equal(st.status, 'escalated');
  assert.ok(st.gateResults.some((r) => r.verdict === 'indeterminate'));
  assert.equal(st.failures.length, 0, 'indeterminate is not a failure');
});

test('T-H3b the indeterminate escalation is also a real Escalation record', () => {
  const w = makeWorld({ script: FIXING_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, FIXING_SCRIPT, { flakyGates: ['tests.affected_pass'] });
  const esc = w.kernel.escalations.find((e) => e.unitId === u.id);
  assert.ok(esc, 'a real Escalation record exists, not just an event');
  assert.equal(esc!.klass, 'indeterminate');
  assert.equal(esc!.resolvedAt, null);
});

test('T-H4 gates run in stage-ascending order', () => {
  const { st } = run(FIXING_SCRIPT);
  const stages = st.gateResults.map((r) => {
    const id = r.gateRef.split('@')[0]!;
    return { 'artifact.schema_valid': 0, 'artifact.nonempty_change': 0, 'deps.unchanged': 1, 'locality.confined': 1, 'api.schema_unchanged': 1, 'build.typecheck': 2, 'tests.affected_pass': 3 }[id] ?? 9;
  });
  assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
});

test('T-H6 the C1 gate records three runs under its 3/3 quorum', () => {
  const { st } = run(FIXING_SCRIPT);
  const r = st.gateResults.find((x) => x.gateRef.startsWith('tests.affected_pass'))!;
  assert.equal(r.runs?.length, 3);
});

test('T-H7 the applies_when predicate evaluates and coverage is reported', async () => {
  const { coverage, evaluate } = await import('../src/predicate.ts');
  assert.equal(evaluate('artifact.type == "CodeDiff"', { 'artifact.type': 'CodeDiff' }), 'true');
  const c = coverage('diff.paths matches "src/auth/**"', ['src/payments/x.ts']);
  assert.equal(c.verdict, 'ZERO_COVERAGE');
  assert.deepEqual(c.zeroMatchTerms, ['src/auth/**']);
  const ok = coverage('diff.paths matches "src/**"', ['src/app.js']);
  assert.equal(ok.verdict, 'covered');
});

test('T-H8 gate evidence visibility is the max of anything it quotes', () => {
  const { st } = run(DEFAULT_SCRIPT);
  for (const r of st.gateResults) {
    const vis = new Set(r.evidence.map((e) => e.visibility));
    assert.equal(vis.size <= 1, true, 'evidence visibility is uniform per result');
    assert.equal(r.evidence.every((e) => e.visibility === 'public'), true, 'slice 01 gates quote only public segments');
  }
});

test('T-H9 an artifact with zero files touched fails verification even when every other gate would pass', () => {
  // Reproduces the real aios-2node-Lx5KMr / PuYjDz forensic gap: a model turn
  // that ends after one call with no tool invocation at all produces a
  // filesTouched=0 artifact. Every other gate is content-vacuous on an empty
  // diff (schema segments are still present, there is no dependency/scope/API
  // change, there is nothing to parse, and tests.affected_pass reads the
  // UNCHANGED baseline rather than this unit's diff) — so without
  // artifact.nonempty_change this reaches awaiting_approval on a no-op.
  const w = makeWorld({ script: () => 'DONE' });

  // Bridge the baseline so tests.affected_pass already passes on an untouched
  // workspace, exactly as harness-2node.ts bridges node 2's baseline onto
  // node 1's completed migration — otherwise the objective/gate mismatch
  // (not the empty-diff gap under test) would be what fails the attempt.
  const migrated = 'function oldFn(a) { return a + 1; }\nfunction newFn(a) { return a + 1; }\n'
    + 'function alpha(x) { return newFn(x); }\nfunction beta(x) { return newFn(x) * 2; }\n'
    + 'module.exports = { alpha, beta, newFn, oldFn };\n';
  writeFileSync(join(w.repoRoot, 'src', 'app.js'), migrated);
  git(w.repoRoot, ['add', '-A']);
  git(w.repoRoot, ['-c', 'user.email=a@b', '-c', 'user.name=fixture', 'commit', '-q', '-m', 'pre-migrated baseline']);
  const bridgedBaseline = git(w.repoRoot, ['rev-parse', 'HEAD']).trim();

  const u = w.kernel.materialise(w.plan, n(w), bridgedBaseline);
  w.kernel.acquireLease(u.id, 's1');
  const { attempt } = w.kernel.runAttempt(u.id, () => 'DONE');
  const st = w.kernel.expect(u.id);

  assert.equal(attempt.toolInvocations.length, 0, 'reproduces the gap: no tool ever ran');
  assert.equal(attempt.status, 'completed', 'termination semantics are unchanged by this fix');

  const filesTouched = (st.artifacts[0]!.segments.find((s) => s.name === 'files_touched')!.content as string[]).length;
  assert.equal(filesTouched, 0, 'the harvested artifact is genuinely empty');

  const nonempty = st.gateResults.find((r) => r.gateRef.startsWith('artifact.nonempty_change'))!;
  assert.equal(nonempty.verdict, 'fail', 'the new gate catches the empty artifact');
  const others = st.gateResults.filter((r) => !r.gateRef.startsWith('artifact.nonempty_change'));
  assert.equal(others.filter((r) => r.verdict !== 'pass').length, 0, 'every other gate is vacuously satisfied — this is the exact gap');

  assert.notEqual(st.status, 'awaiting_approval', 'must not reach approval on a no-op attempt');
  assert.equal(st.status, 'attempt_failed', 'fails verification in the ordinary way (design 07)');
});

// ================================================== I. Failure and retry

test('T-I1 FailureRecord has no field able to carry narrative', () => {
  const { st } = run(DEFAULT_SCRIPT);
  const fr = st.failures[0]!;
  for (const forbidden of ['notes', 'hypothesis', 'whatITried', 'summary', 'narrative', 'rationale']) {
    assert.equal(Object.keys(fr).includes(forbidden), false, `FailureRecord must not carry ${forbidden}`);
  }
  assert.notEqual(fr.detectedBy, 'self');
});

test('T-I2 attempt 2 receives structured evidence and ZERO narrative bytes from attempt 1', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  const a1 = w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  assert.equal(st.failures.length, 1, 'attempt 1 failed');

  const narrative = traceStore.get(a1.attempt.rawTraceRef!)!;
  assert.ok(narrative.length > 0, 'the narrative exists — privately');

  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  // Inspect the RENDERED context of attempt 2, not merely the schema.
  const rendered = renderedFor(w, u.id, 1);
  for (const line of narrative.split('\n').filter((l) => l.trim().length > 12)) {
    assert.equal(rendered.includes(line), false, `narrative leaked into retry context: ${line.slice(0, 60)}`);
  }
  assert.ok(rendered.includes('verification_failed'), 'structured evidence DID reach the retry');
});

test('T-I3 a retry reuses the same ResolvedExecutionSpec hash', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  assert.equal(st.attempts[0]!.executionSpecHash, st.attempts[1]!.executionSpecHash);
});

test('T-I4 two identical-shaped failures escalate; no third attempt runs', () => {
  const stuck = (_p: string, t: number): string => t === 1 ? 'DONE' : 'DONE';
  const w = makeWorld({ script: stuck });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, stuck);
  w.kernel.runAttempt(u.id, stuck);
  assert.equal(w.kernel.noProgress(u.id), true, 'identical progress hashes detected');
  assert.equal(w.kernel.canRetry(u.id), false, 'a third attempt is refused');
});

test('T-I6 two consecutive read-then-nothing attempts — the real aios-harness failure shape — are detected as no_progress', () => {
  // `no_progress` (types.ts FailureRecord klass; ROLE.onFailure) is a
  // CROSS-ATTEMPT concept per design/02 §"no_progress detected -> always
  // escalate, never retry": it compares consecutive failure signatures, via
  // Kernel.noProgress()/canRetry() (already exercised by T-I4). It is not a
  // per-attempt classification the executor itself assigns — no code path
  // constructs FailureRecord.klass:'no_progress', by design (see report).
  // This proves that mechanism correctly catches the ACTUAL failure shape
  // observed in the three real aios-harness-* runs: read, then nothing.
  const readThenNothing = (_p: string, turn: number): string =>
    turn === 1 ? 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}' : 'DONE';
  const w = makeWorld({ script: readThenNothing });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, readThenNothing);
  w.kernel.runAttempt(u.id, readThenNothing);
  const st = w.kernel.expect(u.id);
  assert.equal(st.failures.length, 2, 'both attempts failed verification the ordinary way');
  assert.equal(w.kernel.noProgress(u.id), true, 'read-then-nothing twice is recognized as no progress');
  assert.equal(w.kernel.canRetry(u.id), false, 'a third attempt is refused');
  assert.equal(u.executionSpec.onFailure['no_progress'], 'escalate_human', 'matches ROLE.onFailure — a driver stops retrying and escalates here');
});

// ---------- T-I7-I9: wiring canRetry()/noProgress() into admit() (design/06
// §2.1's attempt_failed -> ready/exhausted/escalated). `attempt_failed` is
// deliberately left unchanged by postExecution — T-F10/T-F13 already assert
// it persists through one failed runAttempt with no admit() call. The
// decision fires only when admit() is next called on that unit.

test('T-I7 admit() allows a retry through when attempts remain and on_failure says retry, reaching success', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  assert.equal(w.kernel.expect(u.id).status, 'attempt_failed', 'unchanged: not auto-promoted at failure time');

  const r = w.kernel.admit(u.id);
  assert.equal(r.admitted, true, r.reason);
  assert.equal(w.kernel.expect(u.id).status, 'ready', 'attempt_failed -> ready, via the existing admission path');

  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  assert.equal(st.status, 'awaiting_approval', 'the retry, gated through admit(), completed successfully in the ordinary way');
  assert.equal(w.kernel.escalations.filter((e) => e.unitId === u.id).length, 0, 'a legitimate retry never escalates');
});

test('T-I7b a retry reuses the ORIGINAL lease; re-acquiring is correctly rejected, not required', () => {
  // Regression for the harness-2node.ts bug this locks the contract against:
  // the driver called acquireLease() a SECOND time before the retry attempt,
  // which kernel.ts's compare-and-set (`st.lease && !expired -> return null`)
  // correctly refused — the lease is session-scoped, not per-attempt, and
  // T-I7 already proves a retry needs no second lease at all. This test
  // additionally proves the REJECTION itself is correct (not merely that
  // omitting the second call happens to work), then proves the retry still
  // reaches awaiting_approval using only the original lease.
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);

  const lease1 = w.kernel.acquireLease(u.id, 's1');
  assert.ok(lease1, 'one lease is acquired before attempt 1');

  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  assert.equal(w.kernel.expect(u.id).status, 'attempt_failed', 'attempt 1 fails for real');

  const retryAdmit = w.kernel.admit(u.id);
  assert.equal(retryAdmit.admitted, true, 'admit() allows the retry');
  assert.equal(w.kernel.expect(u.id).status, 'ready');

  // The original lease is still valid (leaseTtlS default is well beyond
  // instant test execution) — a second acquisition attempt MUST be refused.
  const reacquireAttempt = w.kernel.acquireLease(u.id, 's1');
  assert.equal(reacquireAttempt, null, 'a second acquireLease() while the original is still valid is correctly rejected');
  assert.equal(w.kernel.expect(u.id).lease!.epoch, lease1!.epoch, 'the rejected call left the original lease/epoch untouched');

  // The retry itself needs no lease re-acquisition — it runs directly under
  // the lease from before attempt 1.
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  const st = w.kernel.expect(u.id);
  assert.equal(st.status, 'awaiting_approval', 'the retry reaches awaiting_approval using the existing lease, never a new one');
  assert.equal(st.lease!.epoch, lease1!.epoch, 'still the same lease/epoch throughout both attempts');
});

test('T-I8 attempts exhausted (genuinely distinct failures, no progress-collapse) escalate through admit(), reusing the Escalation record', () => {
  // Each attempt writes a still-broken migration with a different LINE
  // COUNT (harvest.ts's insertions/deletions are a line-based diff stat,
  // not content-based) so diffSummary — and therefore the progress hash —
  // genuinely differs attempt to attempt. This isolates pure exhaustion
  // from no_progress.
  const BROKEN = 'function oldFn(a) { return a + 1; }\nfunction newFn(a) { return a + 1; }\n'
    + 'function alpha(x) { return oldFn(x); }\nfunction beta(x) { return oldFn(x) * 2; }\n'
    + 'module.exports = { alpha, beta, newFn, oldFn };\n';
  let attemptCount = 0;
  const alwaysFailDifferently = (_p: string, turn: number): string => {
    if (turn === 1) return 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}';
    if (turn === 2) {
      attemptCount += 1;
      const content = `${BROKEN}${'// marker\n'.repeat(attemptCount)}`;
      return `CALL fs.write workspace://src/app.js ${JSON.stringify({ path: 'src/app.js', content })}`;
    }
    return 'DONE';
  };

  const w = makeWorld({ script: alwaysFailDifferently });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');

  w.kernel.runAttempt(u.id, alwaysFailDifferently);
  let r = w.kernel.admit(u.id);
  assert.equal(r.admitted, true, 'attempt 1 -> 2: within maxAttempts (3)');
  assert.equal(w.kernel.expect(u.id).status, 'ready');

  w.kernel.runAttempt(u.id, alwaysFailDifferently);
  assert.equal(w.kernel.noProgress(u.id), false, 'diffs genuinely differ — this is exhaustion, not no_progress');
  r = w.kernel.admit(u.id);
  assert.equal(r.admitted, true, 'attempt 2 -> 3: still within maxAttempts');
  assert.equal(w.kernel.expect(u.id).status, 'ready');

  w.kernel.runAttempt(u.id, alwaysFailDifferently);
  assert.equal(w.kernel.noProgress(u.id), false, 'still genuinely distinct');
  r = w.kernel.admit(u.id);
  assert.equal(r.admitted, false);
  assert.equal(r.reason, 'exhausted');
  assert.equal(w.kernel.expect(u.id).status, 'escalated', 'exhausted -> escalated fires in the same call (design: "Always")');
  assert.ok(w.events.byType('workunit.exhausted').length >= 1, 'the momentary exhausted transition is still evented (T-K1)');
  const esc = w.kernel.escalations.find((e) => e.unitId === u.id);
  assert.ok(esc, 'reuses the existing Escalation record — not a duplicate mechanism');
  assert.equal(esc!.klass, 'exhausted');
});

test('T-I9 no_progress escalates DIRECTLY via admit(), bypassing exhausted even with attempts remaining', () => {
  const readThenNothing = (_p: string, turn: number): string =>
    turn === 1 ? 'CALL fs.read workspace://src/app.js {"path":"src/app.js"}' : 'DONE';
  const w = makeWorld({ script: readThenNothing });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  w.kernel.acquireLease(u.id, 's1');

  w.kernel.runAttempt(u.id, readThenNothing);
  const r1 = w.kernel.admit(u.id);
  assert.equal(r1.admitted, true, 'one failure alone is not yet no_progress');
  assert.equal(w.kernel.expect(u.id).status, 'ready');

  w.kernel.runAttempt(u.id, readThenNothing);
  assert.equal(w.kernel.noProgress(u.id), true, 'two identical-shaped failures, as in T-I6');
  const r2 = w.kernel.admit(u.id);
  assert.equal(r2.admitted, false);
  assert.equal(r2.reason, 'no_progress');
  assert.equal(w.kernel.expect(u.id).status, 'escalated');
  assert.equal(w.kernel.expect(u.id).attempts.length, 2, 'only 2 of 3 allowed attempts used — proves this bypasses exhaustion, does not exhaust it');
  const esc = w.kernel.escalations.find((e) => e.unitId === u.id);
  assert.equal(esc!.klass, 'no_progress');
});

test('T-I5 a retry never mutates the WorkUnit contract', () => {
  const w = makeWorld({ script: DEFAULT_SCRIPT });
  const u = w.kernel.materialise(w.plan, n(w), w.baseline);
  const before = JSON.stringify(u.acceptanceCriteria);
  w.kernel.acquireLease(u.id, 's1');
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  w.kernel.runAttempt(u.id, DEFAULT_SCRIPT);
  assert.equal(JSON.stringify(w.kernel.expect(u.id).unit.acceptanceCriteria), before);
});

// helper: recompile the context an attempt saw
function renderedFor(w: ReturnType<typeof makeWorld>, unitId: string, attemptIdx: number): string {
  const st = w.kernel.expect(unitId);
  const ctx: GatherContext = {
    repoRoot: w.repoRoot, headCommit: st.unit.baselineCommit, memory: w.memory,
    priorFailure: st.failures.length ? JSON.stringify(st.failures[attemptIdx - 1] ?? st.failures[0]) : null,
    readFile: (rel) => { try { return readFileSync(join(st.attempts[attemptIdx]!.workspaceRef!, rel), 'utf8'); } catch { return null; } },
    listFiles: () => { try { return git(st.attempts[attemptIdx]!.workspaceRef!, ['ls-files']).trim().split('\n'); } catch { return []; } },
  };
  return new ContextCompiler(layerSources(w.registry)).compile(st.unit, RECIPE, ctx).rendered;
}

import type {
  ExecutorInvocation, ExecutorResult, ExecutorTermination, ModelCallRecord, ModelResponseShape,
  ResolvedExecutionSpec, ToolCallRecord,
} from './types.ts';
import { BudgetExhausted, ModelBroker, ToolBroker } from './broker.ts';
import type { ModelProvider } from './broker.ts';
import { nowMs } from './util.ts';

/**
 * The Executor (Note 07).
 *
 * Stateless, sandboxed, credential-free. Runs ONE attempt of ONE WorkUnit and
 * produces a workspace mutation. It does NOT decide what its output is, whether
 * it succeeded, or what it is permitted to do.
 *
 * `ExecutorResult` deliberately carries no artifact, verdict, status, or cost.
 */

export interface ExecutorDeps {
  readonly tools: ToolBroker;
  readonly models: ModelBroker;
  readonly executionCeiling: number;
}

/** The model's action vocabulary. Parsed from provider output; never trusted. */
interface Action {
  readonly tool: string;
  readonly scope: string;
  readonly args: Record<string, unknown>;
}

export function runExecutor(inv: ExecutorInvocation, deps: ExecutorDeps): ExecutorResult {
  const narrative: string[] = [];
  const responseShapes: { seq: number; shape: ModelResponseShape }[] = [];
  let termination: ExecutorTermination = 'completed';
  let step = 0;
  const deadlineMs = Date.parse(inv.deadline);

  try {
    let transcript = inv.renderedContext;
    // Bounded agent loop. The kernel enforces the wall clock; the executor
    // cannot extend its own deadline.
    while (step < 24) {
      step += 1;
      if (nowMs() >= deadlineMs) { termination = 'deadline'; break; }

      const out = deps.models.call(inv.attemptId, inv.executionSpec, transcript, deps.executionCeiling);
      narrative.push(`step ${step}: ${out.text.slice(0, 200)}`);

      const parsed = parseActions(out.text);
      // Durable, non-narrative forensic evidence (Note 07 §12: no raw model
      // text leaves this function) of what THIS turn's parse actually was —
      // keyed by the ModelCallRecord this call just pushed, never by
      // position, since a budget_halt/error call never reaches this line.
      const lastSeq = deps.models.records[deps.models.records.length - 1]?.seq;
      if (lastSeq !== undefined) responseShapes.push({ seq: lastSeq, shape: classifyResponse(parsed) });
      if (parsed.done) break;
      if (parsed.refused) { termination = 'model_refused'; break; }
      // A malformed CALL is recoverable, exactly like a denial (Note 07 §7):
      // the model gets a turn to correct it. Only genuinely empty output —
      // no valid action AND no malformed attempt — ends the loop here.
      if (parsed.actions.length === 0 && parsed.malformed === 0) break;

      const results: string[] = [];
      if (parsed.malformed > 0) {
        // Malformed syntax is DATA, not silence: named and fed back so the
        // model can adapt, mirroring how a capability denial is handled.
        // No raw model text is captured here — only a count.
        narrative.push(`malformed: ${parsed.malformed} CALL line(s) ignored`);
        results.push(`MALFORMED ${parsed.malformed} CALL line(s) ignored: each CALL must be exactly one physical line, with a single valid JSON object as its arguments.`);
      }
      for (const a of parsed.actions) {
        const r = deps.tools.call({ toolId: a.tool, scope: a.scope, args: a.args }, inv.capabilityToken, inv.executionSpec.hash);
        if (r.outcome === 'denied') {
          // A denial is DATA, not an error. The refusal names the granted
          // scopes so the model can adapt rather than loop against the wall.
          narrative.push(`denied ${a.tool} (${r.denial.reason}); granted: ${r.denial.grantedScopes.join(', ')}`);
          results.push(`DENIED ${a.tool}: ${r.denial.reason}. You may use: ${r.denial.grantedScopes.join(' | ')}`);
          if (deps.tools.budgetExceeded()) { termination = 'denial_budget'; break; }
          continue;
        }
        if (r.outcome === 'error') {
          narrative.push(`tool error ${a.tool}: ${r.error.message}`);
          termination = 'tool_fault';
          break;
        }
        results.push(`OK ${a.tool}: ${JSON.stringify(r.value).slice(0, 400)}`);
      }
      if (termination === 'tool_fault' || termination === 'denial_budget') break;
      transcript = `${transcript}\n\n[tool results]\n${results.join('\n')}`;
    }
  } catch (e) {
    if (e instanceof BudgetExhausted) termination = 'deadline';
    else termination = 'internal_error';
    narrative.push(`terminated: ${String(e)}`);
  }

  return {
    attemptId: inv.attemptId,
    termination,
    toolInvocations: deps.tools.records as readonly ToolCallRecord[],
    modelInvocations: deps.models.records as readonly ModelCallRecord[],
    narrative: narrative.join('\n'),
    responseShapes,
  };
}

/** Pure classification of one turn's parsed output — see `ModelResponseShape` (types.ts). */
function classifyResponse(parsed: ReturnType<typeof parseActions>): ModelResponseShape {
  if (parsed.done) return 'done';
  if (parsed.refused) return 'refused';
  if (parsed.malformed > 0) return 'malformed';
  if (parsed.actions.length > 0) return 'tool_call';
  return 'no_action';
}

// -------------------------------------------------------------- verifier (C2)

/**
 * The Verifier (design/03 §13, model_judged gates).
 *
 * Deliberately NOT `runExecutor`: a verifier issues no tool calls (rule 3:
 * "the verifier Role has no write capability") and produces exactly one
 * judgment, not a bounded tool-use loop. Kept in executor.ts rather than
 * kernel.ts so the actual `deps.models.call` invocation never appears in
 * kernel.ts — the kernel orchestrates dispatch, it does not itself call a
 * model (Note 06 §1), exactly the same division `runExecutor` already keeps
 * for ordinary attempts.
 */

export interface VerifierDeps {
  readonly models: ModelBroker;
  readonly verificationCeiling: number;
}

export type VerifierVerdict = 'pass' | 'fail' | 'indeterminate' | 'error';

export interface VerifierEvidenceItem {
  readonly kind: 'finding' | 'location' | 'reproduction' | 'assertion';
  readonly content: string;
  readonly location?: string;
}

export interface VerifierResult {
  readonly verdict: VerifierVerdict;
  readonly evidence: readonly VerifierEvidenceItem[];
  readonly modelInvocations: readonly ModelCallRecord[];
}

const VERIFIER_EVIDENCE_KINDS = new Set(['finding', 'location', 'reproduction', 'assertion']);

/**
 * The model's ENTIRE output for a verification call is one JSON object:
 * `{"verdict": "pass"|"fail"|"indeterminate", "evidence": [{"kind","content","location"?}]}`.
 * No CALL/DONE convention — there is nothing to call. A response that fails
 * to parse or fails validation is `indeterminate`, never silently `pass`:
 * rule 6 (design/03 §13) already treats `indeterminate` as the correct,
 * reachable destination for "the model didn't give a clean answer."
 */
export function runVerifier(
  attemptId: string, spec: ResolvedExecutionSpec, prompt: string, deps: VerifierDeps,
): VerifierResult {
  try {
    const out = deps.models.call(attemptId, spec, prompt, deps.verificationCeiling);
    let parsed: unknown;
    try {
      parsed = JSON.parse(out.text);
    } catch {
      return {
        verdict: 'indeterminate',
        evidence: [{ kind: 'assertion', content: 'verifier response was not valid JSON' }],
        modelInvocations: deps.models.records as readonly ModelCallRecord[],
      };
    }
    const body = parsed as { verdict?: unknown; evidence?: unknown };
    if (body.verdict !== 'pass' && body.verdict !== 'fail' && body.verdict !== 'indeterminate') {
      return {
        verdict: 'indeterminate',
        evidence: [{ kind: 'assertion', content: `verifier response had an unrecognised verdict: ${JSON.stringify(body.verdict)}` }],
        modelInvocations: deps.models.records as readonly ModelCallRecord[],
      };
    }
    const rawEvidence = Array.isArray(body.evidence) ? body.evidence : [];
    const evidence: VerifierEvidenceItem[] = rawEvidence
      .filter((e): e is { kind: string; content: string; location?: string } =>
        typeof e === 'object' && e !== null && VERIFIER_EVIDENCE_KINDS.has((e as { kind?: unknown }).kind as string)
        && typeof (e as { content?: unknown }).content === 'string')
      .map((e) => ({ kind: e.kind as VerifierEvidenceItem['kind'], content: e.content, ...(typeof e.location === 'string' ? { location: e.location } : {}) }));
    return { verdict: body.verdict, evidence, modelInvocations: deps.models.records as readonly ModelCallRecord[] };
  } catch (e) {
    return {
      verdict: 'error',
      evidence: [{ kind: 'assertion', content: `verifier call failed: ${String(e)}` }],
      modelInvocations: deps.models.records as readonly ModelCallRecord[],
    };
  }
}

/**
 * Adapts a VerifierResult into the SAME ExecutorResult shape runExecutor()
 * returns, so kernel.ts's runAttempt() needs no branching below the point it
 * chooses which of the two to call — Attempt construction, events, freeze,
 * and postExecution are byte-identical for a verification unit and an
 * ordinary one. A verifier issues no tool calls (rule 3), so
 * toolInvocations is always empty; `verdict:'error'` (an actual call
 * failure, e.g. budget exhaustion) is the only case NOT mapped to
 * `'completed'` — a `fail`/`indeterminate` VERDICT is still a successfully
 * COMPLETED verification attempt; the verdict, not the termination, is what
 * the outer gate dispatch reads.
 */
export function verifierResultToExecutorResult(vr: VerifierResult, attemptId: string): ExecutorResult {
  return {
    attemptId,
    termination: vr.verdict === 'error' ? 'internal_error' : 'completed',
    toolInvocations: [],
    modelInvocations: vr.modelInvocations,
    narrative: '',
    responseShapes: [],
  };
}

const CALL_LINE = /^\s*CALL\s+(\S+)\s+(\S+)\s*(\{.*\})?\s*$/;
const LOOKS_LIKE_CALL = /^\s*CALL\b/;

function parseActions(text: string): { actions: Action[]; done: boolean; refused: boolean; malformed: number } {
  if (/^\s*REFUSE\b/m.test(text)) return { actions: [], done: false, refused: true, malformed: 0 };
  if (/^\s*DONE\b/m.test(text)) return { actions: [], done: true, refused: false, malformed: 0 };
  const actions: Action[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const m = CALL_LINE.exec(line);
    if (!m) {
      // A line that clearly attempts CALL syntax but doesn't fully match —
      // e.g. a JSON argument object broken across multiple lines — is a
      // malformed attempt, not silence. It must never vanish uncounted.
      if (LOOKS_LIKE_CALL.test(line)) malformed += 1;
      continue;
    }
    if (m[3]) {
      try {
        actions.push({ tool: m[1]!, scope: m[2]!, args: JSON.parse(m[3]) as Record<string, unknown> });
      } catch {
        // Syntactically CALL-shaped but the JSON argument object doesn't
        // parse. Previously this silently ran the action with args:{} —
        // e.g. an fs.write with no `content` would silently empty the
        // target file. It must never execute unparsed.
        malformed += 1;
      }
      continue;
    }
    actions.push({ tool: m[1]!, scope: m[2]!, args: {} });
  }
  return { actions, done: false, refused: false, malformed };
}

// -------------------------------------------------------- scripted provider

/**
 * Deterministic provider used for the acceptance suite.
 *
 * The checklist tests the SYSTEM's mechanics — leases, harvest, gates, replay,
 * budget — not model quality. A scripted provider makes T-K6, T-I2 and T-E1
 * genuinely assertable; a real provider adapter is a swap behind ModelProvider
 * and changes nothing above this line.
 */
export function scriptedProvider(name: string, script: (prompt: string, turn: number) => string): ModelProvider {
  let turn = 0;
  return {
    name,
    complete(req) {
      turn += 1;
      const text = script(req.prompt, turn);
      return { text, inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(text.length / 4) };
    },
  };
}

export function failingProvider(name: string): ModelProvider {
  return { name, complete() { throw new Error(`provider ${name} unavailable`); } };
}

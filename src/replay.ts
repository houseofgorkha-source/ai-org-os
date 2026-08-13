import type { EventStore } from './events.ts';
import type { Kernel } from './kernel.ts';
import type { ContextRecipe, WorkUnit } from './types.ts';
import { ContextCompiler } from './context.ts';
import type { GatherContext, LayerSource } from './context.ts';

/**
 * Replay (Note 02 §14).
 *
 * Mode 1 (audit)   — what did the system see and decide? Deterministic, no
 *                    model call. ALWAYS guaranteed.
 * Mode 2 (context) — does recompiling from pinned sources reproduce the
 *                    manifest hash? Deterministic; the compiler is a pure fn.
 * Mode 3 (execution) — NOT deterministic and NOT guaranteed. Deliberately not
 *                    implemented: conflating it with 1 and 2 is how a system
 *                    ends up claiming reproducibility it cannot deliver.
 */

export interface AuditReplay {
  readonly unitId: string;
  readonly attempts: readonly {
    readonly attemptId: string;
    readonly ordinal: number;
    readonly specHash: string;
    readonly contextManifestRef: string | null;
    readonly renderedPromptHash: string | null;
    readonly modelsServed: readonly string[];
    readonly toolCalls: readonly { seq: number; toolId: string; outcome: string; denialReason?: string }[];
    readonly status: string;
    readonly producedArtifact: string | null;
  }[];
  readonly gateResults: readonly { gateRef: string; verdict: string }[];
  readonly artifacts: readonly { id: string; contentHash: string; status: string }[];
  readonly approvals: readonly { id: string; subjectHash: string }[];
  readonly events: number;
  readonly complete: boolean;
}

export function replayAudit(kernel: Kernel, events: EventStore, unitId: string): AuditReplay {
  const st = kernel.expect(unitId);
  const attempts = st.attempts.map((a) => ({
    attemptId: a.id,
    ordinal: a.ordinal,
    specHash: a.executionSpecHash,
    contextManifestRef: a.contextManifestRef,
    renderedPromptHash: a.renderedPromptHash,
    modelsServed: a.modelInvocations.map((m) => m.modelServed),
    toolCalls: a.toolInvocations.map((t) => {
      const base = { seq: t.seq, toolId: t.toolId, outcome: t.outcome };
      return t.denialReason ? { ...base, denialReason: t.denialReason } : base;
    }),
    status: a.status,
    producedArtifact: a.producedArtifact,
  }));
  // Completeness: every attempt must carry the full capture set.
  const complete = attempts.every((a) =>
    a.specHash !== '' && a.contextManifestRef !== null && a.renderedPromptHash !== null && a.status !== 'running');
  return {
    unitId,
    attempts,
    gateResults: st.gateResults.map((r) => ({ gateRef: r.gateRef, verdict: r.verdict })),
    artifacts: st.artifacts.map((a) => ({ id: a.id, contentHash: a.contentHash, status: a.status })),
    approvals: kernel.approvals.map((a) => ({ id: a.id, subjectHash: a.subject.contentHash })),
    events: events.bySubject(unitId).length,
    complete,
  };
}

export interface ContextReplayResult {
  readonly manifestId: string;
  readonly originalHash: string;
  readonly recomputedHash: string;
  readonly matches: boolean;
}

export function replayContext(
  unit: WorkUnit, recipe: ContextRecipe, sources: Map<string, LayerSource>,
  ctx: GatherContext, originalManifestId: string, originalHash: string,
): ContextReplayResult {
  const { manifest } = new ContextCompiler(sources).compile(unit, recipe, ctx);
  return {
    manifestId: originalManifestId,
    originalHash,
    recomputedHash: manifest.assembledHash,
    matches: manifest.assembledHash === originalHash,
  };
}

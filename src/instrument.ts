import type { EventStore } from './events.ts';
import type { Kernel } from './kernel.ts';
import type { Money } from './types.ts';

/**
 * Instrumentation (Appendix A).
 *
 * All measures are PROJECTIONS over the event stream. None is self-reported by
 * an agent: `self_report_accepted: false` applies to metrics exactly as it does
 * to verdicts, and a metered party never reports its own meter.
 */

export interface Measures {
  readonly m1_costPerAcceptedChange: Record<string, number | null>;
  readonly m2_gateCatchAndCost: Record<string, { runs: number; catches: number; cost: Money }>;
  readonly m3_indeterminateRate: Record<string, number>;
  readonly m4_verifierDisagreement: { samples: number; disagreements: number; rate: number | null };
  readonly m5_reworkRate: { accepted: number; reworked: number; rate: number | null };
  readonly m6_denialRateByRole: Record<string, number>;
}

/**
 * M4 harness — INSTRUMENTATION ONLY.
 *
 * It reads GateResult rows and records a human agreement flag. It introduces no
 * C2 gate, no model-judged verifier, and no escalation path. Slice 01 has no
 * verifier, so it is exercised against a synthetic hand-written `pass` row.
 */
export class DisagreementSampler {
  private readonly rows: { gateRef: string; verdict: string; humanAgrees: boolean }[] = [];
  sample(gateRef: string, verdict: string, humanAgrees: boolean): void {
    if (verdict !== 'pass') return;      // sample PASSES, not failures
    this.rows.push({ gateRef, verdict, humanAgrees });
  }
  stats(): { samples: number; disagreements: number; rate: number | null } {
    const samples = this.rows.length;
    const disagreements = this.rows.filter((r) => !r.humanAgrees).length;
    return { samples, disagreements, rate: samples === 0 ? null : disagreements / samples };
  }
}

export function computeMeasures(kernel: Kernel, events: EventStore, sampler: DisagreementSampler, spendByUnit: (unitId: string) => Money): Measures {
  const m1: Record<string, number | null> = {};
  const byClass = new Map<string, { cost: number; accepted: number }>();
  for (const st of kernel.units.values()) {
    const e = byClass.get(st.unit.klass) ?? { cost: 0, accepted: 0 };
    e.cost += spendByUnit(st.unit.id);
    if (st.status === 'accepted') e.accepted += 1;
    byClass.set(st.unit.klass, e);
  }
  for (const [k, v] of byClass) m1[k] = v.accepted === 0 ? null : round4(v.cost / v.accepted);

  const m2: Record<string, { runs: number; catches: number; cost: Money }> = {};
  const m3counts = new Map<string, { total: number; indet: number }>();
  for (const st of kernel.units.values()) {
    for (const r of st.gateResults) {
      const e = m2[r.gateRef] ?? { runs: 0, catches: 0, cost: 0 };
      e.runs += 1;
      if (r.verdict === 'fail') e.catches += 1;
      e.cost += r.cost;
      m2[r.gateRef] = e;
      const c = m3counts.get(r.gateRef) ?? { total: 0, indet: 0 };
      c.total += 1;
      if (r.verdict === 'indeterminate') c.indet += 1;
      m3counts.set(r.gateRef, c);
    }
  }
  const m3: Record<string, number> = {};
  for (const [k, v] of m3counts) m3[k] = v.total === 0 ? 0 : round4(v.indet / v.total);

  const accepted = [...kernel.units.values()].filter((s) => s.status === 'accepted').length;
  const reworked = [...kernel.units.values()].filter((s) => s.status === 'accepted' && s.attempts.length > 1).length;

  const m6: Record<string, number> = {};
  for (const st of kernel.units.values()) {
    const role = st.unit.executionSpec.roleRef;
    const denials = st.attempts.reduce((a, at) => a + at.toolInvocations.filter((t) => t.outcome === 'denied').length, 0);
    m6[role] = (m6[role] ?? 0) + denials;
  }
  void events;

  return {
    m1_costPerAcceptedChange: m1,
    m2_gateCatchAndCost: m2,
    m3_indeterminateRate: m3,
    m4_verifierDisagreement: sampler.stats(),
    m5_reworkRate: { accepted, reworked, rate: accepted === 0 ? null : round4(reworked / accepted) },
    m6_denialRateByRole: m6,
  };
}

/**
 * Paired-reading rule (Appendix A): an efficiency measure must never be
 * displayed without its paired quality measure. Enforced in the reporting layer.
 */
export function report(m: Measures): string[] {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(m.m1_costPerAcceptedChange)) {
    lines.push(`M1 cost/accepted[${k}] = ${v}   (paired M5 rework rate = ${m.m5_reworkRate.rate})`);
  }
  for (const [k, v] of Object.entries(m.m2_gateCatchAndCost)) {
    lines.push(`M2 ${k}: runs=${v.runs} catches=${v.catches} cost=${v.cost}   (catch rate paired with cost)`);
  }
  for (const [k, v] of Object.entries(m.m3_indeterminateRate)) lines.push(`M3 ${k} indeterminate_rate = ${v}`);
  lines.push(`M4 verifier disagreement = ${JSON.stringify(m.m4_verifierDisagreement)}`);
  lines.push(`M5 rework = ${JSON.stringify(m.m5_reworkRate)}`);
  for (const [k, v] of Object.entries(m.m6_denialRateByRole)) lines.push(`M6 denials[${k}] = ${v}`);
  return lines;
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

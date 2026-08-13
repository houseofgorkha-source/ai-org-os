import type { TaskPlan, Artifact, Approval, WorkUnit } from './types.ts';
import type { Registry } from './registry.ts';
import type { InstancePolicy } from './resolve.ts';
import { parseRef } from './util.ts';

/**
 * Kernel validation (Note 02 §9, extended by E1.5).
 *
 * Fully deterministic. NO model call. Runs BEFORE any token is spent — which is
 * what makes it worth doing thoroughly. A rejection that costs a token is a bug.
 */

export interface ValidationIssue { readonly rule: string; readonly message: string }
export interface ValidationResult { readonly ok: boolean; readonly issues: readonly ValidationIssue[] }

export interface ValidationEnv {
  readonly registry: Registry;
  readonly policy: InstancePolicy;
  readonly intents: ReadonlySet<string>;
  readonly memoryObjectiveIds: ReadonlySet<string>;
  readonly artifacts: ReadonlyMap<string, Artifact>;
  readonly approvals: readonly Approval[];
  readonly instanceRemaining: number;
}

export function validatePlan(plan: TaskPlan, env: ValidationEnv): ValidationResult {
  const issues: ValidationIssue[] = [];
  const add = (rule: string, message: string): void => { issues.push({ rule, message }); };
  const nodeIds = new Set(plan.nodes.map((n) => n.nodeId));

  // ---- STRUCTURE (C1, C2) ----------------------------------------------
  for (const e of plan.edges) {
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) add('C-structure', `edge ${e.from}->${e.to} has an unresolved endpoint`);
    if ((e.kind as string) === 'resource') add('C2', 'a `resource` edge was authored; conflict edges are derived by the kernel (E1.3)');
  }
  if (hasCycle(plan)) add('C1', 'authored graph is not acyclic');

  // ---- ADMISSION (C3, C4, C5) ------------------------------------------
  const verificationRoles = env.registry.verificationRoles();
  for (const n of plan.nodes) {
    const admitted = env.policy.admittedRoles.find((a) => parseRef(a.roleRef).id === parseRef(n.roleRef).id);
    if (!admitted) add('C3', `role ${n.roleRef} is not admitted for this instance`);
    else if (!admitted.mayAppearInPlans) add('C3', `role ${n.roleRef} is admitted but may not appear in plans`);
    if (verificationRoles.has(parseRef(n.roleRef).id)) {
      add('C4', `role ${n.roleRef} is a gate's executing role and may never be a plan node (Note 03 §1)`);
    }
    if ((n.klass as string) === 'verification') add('C5', `node ${n.nodeId} declares class: verification, which does not exist`);
    if (!env.registry.hasRole(n.roleRef)) add('C-config', `role ${n.roleRef} does not resolve to an active version`);
  }

  // ---- TYPES (C6) -------------------------------------------------------
  for (const n of plan.nodes) {
    if (!env.registry.hasRole(n.roleRef)) continue;
    const role = env.registry.getRole(n.roleRef);
    if (n.expectedOutput !== role.produces) {
      add('C6', `node ${n.nodeId}: expected_output ${n.expectedOutput} != role produces ${role.produces}`);
    }
  }
  const byId = new Map(plan.nodes.map((n) => [n.nodeId, n]));
  for (const e of plan.edges) {
    if (e.kind !== 'artifact') continue;
    const from = byId.get(e.from); const to = byId.get(e.to);
    if (!from || !to || !env.registry.hasRole(to.roleRef)) continue;
    const consumer = env.registry.getRole(to.roleRef);
    if (!consumer.consumes.includes(from.expectedOutput)) {
      add('C6', `artifact edge ${e.from}->${e.to}: ${from.expectedOutput} is not in consumer's consumes`);
    }
  }

  // ---- CRITERIA (C7, C8, C9) -------------------------------------------
  for (const n of plan.nodes) {
    if (n.acceptanceCriteria.length === 0) add('C8', `node ${n.nodeId} has no acceptance criteria`);
    let mechanical = 0;
    for (const c of n.acceptanceCriteria) {
      if (!env.registry.hasGate(c.check.gateRef)) {
        add('C7', `criterion ${c.id}: gate ${c.check.gateRef} does not resolve to an active gate`);
        continue;
      }
      const gate = env.registry.getGate(c.check.gateRef);
      if (gate.criterionClass !== c.klass) {
        add('C7', `criterion ${c.id}: class ${c.klass} != gate criterion_class ${gate.criterionClass}`);
      }
      if (!gate.appliesTo.includes(n.expectedOutput)) {
        add('C7', `criterion ${c.id}: gate does not apply to ${n.expectedOutput}`);
      }
      for (const seg of gate.requiresSegments) {
        if (PRIVATE_SEGMENTS.has(seg)) add('C9', `criterion ${c.id}: gate requests private segment '${seg}'`);
      }
      if (c.klass === 'C0' || c.klass === 'C1') mechanical += 1;
    }
    if (mechanical === 0) add('C8', `node ${n.nodeId} has no C0 or C1 criterion (Note 02 §3 rule 4)`);
    for (const con of n.constraints) {
      if (!con.sourceArtifact) continue;
      const src = env.artifacts.get(con.sourceArtifact);
      if (!src) { add('C-constraint', `constraint source ${con.sourceArtifact} does not resolve`); continue; }
      const seg = src.segments.find((s) => s.name === 'constraints');
      const have = new Set(((seg?.content as { id: string }[] | undefined) ?? []).map((x) => x.id));
      for (const id of con.constraintIds) if (!have.has(id)) add('C-constraint', `constraint ${id} not present in ${con.sourceArtifact}`);
    }
  }

  // ---- INPUTS (C9) ------------------------------------------------------
  // (slice 01 has no artifact inputs; the rule is exercised by T-C9 fixtures)

  // ---- LINEAGE / INTENT (C10) ------------------------------------------
  if (env.memoryObjectiveIds.has(plan.intentRef)) {
    add('C10', `intent_ref ${plan.intentRef} is a MemoryRecord of kind objective; an objective may inform work but never spawn it (Note 05 §2.6)`);
  } else if (!env.intents.has(plan.intentRef)) {
    add('C10', `intent_ref ${plan.intentRef} does not resolve to an Intent`);
  }
  if (plan.supersedes && !plan.replanReason) add('C-lineage', 'supersedes is set but replan_reason is absent');
  if (!plan.supersedes && plan.replanReason) add('C-lineage', 'replan_reason is set but supersedes is absent');

  // ---- BUDGET (C11) -----------------------------------------------------
  const sum = plan.nodes.reduce((a, n) => a + n.budget.execution + n.budget.verification, 0);
  if (plan.budgetAggregate.execution + plan.budgetAggregate.verification < sum) {
    add('C11', 'budget_aggregate is below the sum of node budgets');
  }
  if (plan.budgetAggregate.execution + plan.budgetAggregate.verification > env.instanceRemaining) {
    add('C11', 'budget_aggregate exceeds instance remaining headroom');
  }
  for (const n of plan.nodes) {
    if (n.budget.execution <= 0) add('C11', `node ${n.nodeId} has non-positive execution budget`);
  }

  return { ok: issues.length === 0, issues };
}

const PRIVATE_SEGMENTS = new Set(['reasoning_trace', 'self_assessment']);

/** C12: blocking pre-dispatch approvals must exist, bound to this content hash. */
export function validateDispatchApprovals(
  unit: WorkUnit, planContentHash: string, approvals: readonly Approval[],
): ValidationResult {
  const issues: ValidationIssue[] = [];
  const needed = unit.approvalsRequired.filter((a) => a.blocking && a.kind === 'pre_dispatch');
  for (const _n of needed) {
    const ok = approvals.some((a) =>
      a.subject.kind === 'plan' && a.subject.contentHash === planContentHash &&
      a.decision === 'approve' && quorumMet(a));
    if (!ok) issues.push({ rule: 'C12', message: 'blocking pre-dispatch approval absent or not bound to this content hash' });
  }
  return { ok: issues.length === 0, issues };
}

export function quorumMet(a: Approval): boolean {
  const m = /^(\d+)\s+of\s+(\d+)$/.exec(a.quorum);
  const need = m ? Number(m[1]) : 1;
  // All signatures must bind the SAME content hash; any change voids every one.
  const valid = a.signatures.filter((s) => s.contentHash === a.subject.contentHash);
  return valid.length >= need;
}

function hasCycle(plan: TaskPlan): boolean {
  const adj = new Map<string, string[]>();
  for (const n of plan.nodes) adj.set(n.nodeId, []);
  for (const e of plan.edges) adj.get(e.from)?.push(e.to);
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const nx of adj.get(id) ?? []) if (visit(nx)) return true;
    state.set(id, 2);
    return false;
  };
  for (const n of plan.nodes) if (visit(n.nodeId)) return true;
  return false;
}

import type {
  ResolvedExecutionSpec, CapabilityGrant, GateBinding, EffectiveBudget, PlanNode, Money,
} from './types.ts';
import type { Registry } from './registry.ts';
import { hashOf, scopeContains } from './util.ts';

/**
 * Resolution (Note 02 §7).
 *
 * Composition happens ONCE, at dispatch, deterministically, and the result is
 * frozen. Replay reads one hash rather than chasing version histories.
 *
 * "Decompose the authoring model; flatten the execution model."
 */

export interface InstancePolicy {
  readonly instanceId: string;
  readonly version: string;
  /** Narrow only — may never widen. */
  readonly capabilityRestrictions: {
    readonly denyTools: readonly string[];
    readonly restrictScopes: Record<string, string>;
    readonly maxRepositoryMode?: 'none' | 'read' | 'worktree_write';
    readonly mayPush?: boolean;
  };
  readonly modelTierCap: 'frontier' | 'standard' | 'fast';
  /** Oblige only — union, never removal. */
  readonly gateObligations: readonly GateBinding[];
  readonly admittedRoles: readonly { readonly roleRef: string; readonly mayAppearInPlans: boolean; readonly maxConcurrent: number }[];
  readonly budgetPolicy: {
    readonly perWorkUnitCap: { readonly execution: Money; readonly verification: Money };
    readonly perPlanCap: Money;
    readonly perDayCap: Money;
    readonly maxRunningUnits: number;
  };
  readonly classPolicy: readonly { readonly klass: string; readonly enabled: boolean; readonly extraGates: readonly string[]; readonly promotionRules: readonly string[] }[];
}

/**
 * Fleet-level tier binding, read through a RESOLVER SEAM (C4).
 * Nothing reads tier bindings from the instance object directly; today the
 * resolver returns instance values, later fleet ∩ instance. That seam is the
 * entire cost of keeping instance #2 cheap.
 */
export interface TierBindingResolver {
  resolveCandidates(tier: string): { candidates: readonly string[]; bindingRef: string };
  resolveFloor(): { mandatoryGates: readonly string[] };
  resolveAttentionBudget(principal: string): { maxOpenEscalations: number; maxPendingApprovals: number };
}

export function makeResolver(table: Record<string, readonly string[]>, bindingRef: string): TierBindingResolver {
  return {
    resolveCandidates(tier) { return { candidates: table[tier] ?? [], bindingRef }; },
    resolveFloor() { return { mandatoryGates: [] }; },
    resolveAttentionBudget() { return { maxOpenEscalations: 5, maxPendingApprovals: 5 }; },
  };
}

const TIER_ORDER = ['fast', 'standard', 'frontier'];

export function resolveSpec(
  node: PlanNode,
  registry: Registry,
  policy: InstancePolicy,
  resolver: TierBindingResolver,
  planRemaining: Money,
): ResolvedExecutionSpec {
  const role = registry.getRole(node.roleRef);
  const capProfile = registry.getCapabilityProfile(role.capabilityProfileRef);
  const gateProfile = registry.getGateProfile(role.gateProfileRef);

  // ---- NARROW: capabilities = role ∩ instance ---------------------------
  const denies = [...new Set([...capProfile.capabilityDenies, ...policy.capabilityRestrictions.denyTools])];
  const capabilities: CapabilityGrant[] = [];
  for (const g of capProfile.capabilities) {
    if (denies.includes(g.tool)) continue;
    const restrict = policy.capabilityRestrictions.restrictScopes[g.tool];
    if (restrict) {
      if (!scopeContains(g.scope, restrict)) {
        throw new Error(`instance policy attempts to WIDEN scope for ${g.tool}: ${restrict} not within ${g.scope}`);
      }
      capabilities.push({ ...g, scope: restrict });
    } else {
      capabilities.push(g);
    }
  }

  const perms = capProfile.permissions;
  const narrowedPerms: typeof perms = {
    ...perms,
    repository: {
      ...perms.repository,
      mode: narrowRepoMode(perms.repository.mode, policy.capabilityRestrictions.maxRepositoryMode),
      mayPush: perms.repository.mayPush && (policy.capabilityRestrictions.mayPush ?? true),
    },
  };

  // Every granted tool must be registered and signed; `effects: external` is
  // unreachable while external_effects are false (E4.3).
  for (const g of capabilities) {
    const tool = registry.getTool(g.tool);
    if (tool.effects === 'external') {
      const ee = narrowedPerms.externalEffects;
      if (!ee.maySend && !ee.mayDeploy && !ee.maySpend) {
        throw new Error(`tool ${g.tool} declares effects: external but external_effects are all false`);
      }
    }
  }

  // ---- OBLIGE: gates = role ∪ instance ∪ class --------------------------
  const classPolicy = policy.classPolicy.find((c) => c.klass === node.klass);
  const extra: GateBinding[] = (classPolicy?.extraGates ?? []).map((g, i) => ({ gateRef: g, blocking: true, order: 900 + i }));
  const merged = new Map<string, GateBinding>();
  for (const b of [...gateProfile.bindings, ...policy.gateObligations, ...extra]) {
    const prev = merged.get(b.gateRef);
    // Monotonic strengthening: blocking beats advisory; order-independent.
    merged.set(b.gateRef, prev ? { ...prev, blocking: prev.blocking || b.blocking } : b);
  }
  const bindings = [...merged.values()].sort((a, b) => a.order - b.order);

  // ---- MIN: budget = role ∩ instance ∩ plan-remaining -------------------
  const budget: EffectiveBudget = {
    execution: {
      costCeiling: Math.min(role.budget.perAttempt.costCeiling, policy.budgetPolicy.perWorkUnitCap.execution, node.budget.execution, planRemaining),
      wallClockS: role.budget.perAttempt.wallClockS,
      toolCalls: role.budget.perAttempt.toolCalls,
    },
    verification: {
      cost: Math.min(policy.budgetPolicy.perWorkUnitCap.verification, node.budget.verification),
      wallClockS: 300,
      modelGateCalls: 0,
    },
    maxAttempts: role.budget.perWorkUnit.maxAttempts,
    filesTouched: role.budget.perWorkUnit.filesTouched,
  };

  // ---- BIND: tier → candidates, via the resolver seam -------------------
  const cappedTier = TIER_ORDER.indexOf(role.model.tier) > TIER_ORDER.indexOf(policy.modelTierCap)
    ? policy.modelTierCap : role.model.tier;
  const binding = resolver.resolveCandidates(cappedTier);

  const body = {
    roleRef: node.roleRef,
    promptRef: role.promptRef,
    contextRecipeRef: role.contextRecipeRef,
    artifactSchemaRef: role.artifactSchema,
    effectiveCapabilities: {
      resolvedFrom: [role.capabilityProfileRef, `instance_policy://${policy.instanceId}/${policy.version}`],
      capabilities, denies, permissions: narrowedPerms,
    },
    effectiveGates: {
      resolvedFrom: [role.gateProfileRef, `instance_policy://${policy.instanceId}/${policy.version}`, `class://${node.klass}`],
      bindings,
    },
    effectiveBudget: budget,
    modelBinding: { tier: cappedTier, resolvedCandidates: binding.candidates, bindingRef: binding.bindingRef },
    onFailure: role.onFailure,
  };
  return { ...body, hash: hashOf(body) };
}

function narrowRepoMode(role: 'none' | 'read' | 'worktree_write', cap?: 'none' | 'read' | 'worktree_write'): 'none' | 'read' | 'worktree_write' {
  if (!cap) return role;
  const order = ['none', 'read', 'worktree_write'];
  return order.indexOf(cap) < order.indexOf(role) ? cap : role;
}

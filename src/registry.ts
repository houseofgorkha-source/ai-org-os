import type {
  ToolDef, GateDef, CapabilityProfile, GateProfile, RoleDef, ContextRecipe,
  GateContextSource, VersionedRef,
} from './types.ts';
import { parseRef, sign, verifySignature } from './util.ts';

/**
 * Registries (Note 03 §8, extended to tools by E4).
 *
 * Human-only authoring, versioned, immutable once published, signed, and
 * fixture-tested with mandatory NEGATIVE coverage. Registration is the trust
 * root: nothing may reference an unsigned or unregistered object.
 */

export class RegistryError extends Error {}

/** D3: closed enumeration. A memory source may never be added. */
const ALLOWED_GATE_CONTEXT: readonly string[] = [
  'workspace_snapshot', 'baseline_artifact', 'constraint_refs', 'runtime_environment',
];

export function isAllowedGateContext(s: string): s is GateContextSource {
  return ALLOWED_GATE_CONTEXT.includes(s);
}

export class Registry {
  private tools = new Map<string, ToolDef>();
  private gates = new Map<string, GateDef>();
  private capProfiles = new Map<string, CapabilityProfile>();
  private gateProfiles = new Map<string, GateProfile>();
  private roles = new Map<string, RoleDef>();
  private recipes = new Map<string, ContextRecipe>();
  private prompts = new Map<string, string>();
  /** Append-only registry audit log, outside any instance's reach (C2a). */
  readonly auditLog: { at: string; action: string; ref: string; by: string }[] = [];

  // ------------------------------------------------------------------ tools

  registerTool(t: ToolDef, approvedBy: string): void {
    if (!approvedBy) throw new RegistryError('tool registration requires human approval');
    if (t.fixtures.mustDeny.length === 0) {
      throw new RegistryError(`tool ${t.id}: at least one must_deny fixture is required (E4.4)`);
    }
    if (t.fixtures.mustSucceed.length === 0) {
      throw new RegistryError(`tool ${t.id}: at least one must_succeed fixture is required`);
    }
    const { signature, ...body } = t;
    if (!verifySignature(body, signature)) throw new RegistryError(`tool ${t.id}: invalid signature`);
    this.tools.set(`${t.id}@${t.version}`, t);
    this.auditLog.push({ at: new Date(0).toISOString(), action: 'register_tool', ref: `${t.id}@${t.version}`, by: approvedBy });
  }

  getTool(ref: VersionedRef): ToolDef {
    const t = this.tools.get(ref) ?? this.latest(this.tools, ref);
    if (!t) throw new RegistryError(`unregistered tool: ${ref}`);
    const { signature, ...body } = t;
    if (!verifySignature(body, signature)) throw new RegistryError(`unsigned tool: ${ref}`);
    return t;
  }

  hasTool(ref: VersionedRef): boolean {
    try { this.getTool(ref); return true; } catch { return false; }
  }

  // ------------------------------------------------------------------ gates

  registerGate(g: GateDef, approvedBy: string): void {
    if (!approvedBy) throw new RegistryError('gate registration requires human approval');
    if (!g.passMeans) throw new RegistryError(`gate ${g.id}: pass_means is mandatory`);
    // Note 03 §8's must_fail requirement "does not extend to C2 model-judged
    // gates" (§19.2: "a fixture the verifier rejects this week may pass next
    // week after a model update" — fixture-testing a model's judgment is
    // structurally meaningless, not merely inconvenient).
    if (g.criterionClass !== 'C2' && g.fixtures.mustFail.length === 0) {
      throw new RegistryError(`gate ${g.id}: at least one must_fail fixture is required (Note 03 §8)`);
    }
    if (g.criterionClass !== 'C2' && g.fixtures.mustPass.length === 0) {
      throw new RegistryError(`gate ${g.id}: at least one must_pass fixture is required`);
    }
    for (const src of g.requiresContext) {
      if (!isAllowedGateContext(src)) {
        throw new RegistryError(`gate ${g.id}: context source '${src}' is outside the closed enumeration (D3)`);
      }
    }
    if (g.criterionClass === 'C0' && !g.determinism) {
      throw new RegistryError(`gate ${g.id}: C0 gates require determinism`);
    }
    if (g.kind === 'model_judged' && !g.executionRoleRef) {
      throw new RegistryError(`gate ${g.id}: model_judged gates require executionRoleRef (design/03 §13)`);
    }
    const { signature, ...body } = g;
    if (!verifySignature(body, signature)) throw new RegistryError(`gate ${g.id}: invalid signature`);
    this.gates.set(`${g.id}@${g.version}`, g);
    this.auditLog.push({ at: new Date(0).toISOString(), action: 'register_gate', ref: `${g.id}@${g.version}`, by: approvedBy });
  }

  getGate(ref: VersionedRef): GateDef {
    const g = this.gates.get(ref) ?? this.latest(this.gates, ref);
    if (!g) throw new RegistryError(`unregistered gate: ${ref}`);
    const { signature, ...body } = g;
    if (!verifySignature(body, signature)) throw new RegistryError(`unsigned gate: ${ref}`);
    if (g.status !== 'active') throw new RegistryError(`gate not active: ${ref}`);
    return g;
  }

  hasGate(ref: VersionedRef): boolean {
    try { this.getGate(ref); return true; } catch { return false; }
  }

  allGates(): readonly GateDef[] { return [...this.gates.values()]; }

  /**
   * A Role appearing as a gate's executing role is a VERIFICATION role and may
   * never be a plan node (E1.5 / B10). Slice 01 registers no model_judged gate,
   * so this set is empty — but the check exists and is exercised.
   */
  verificationRoles(): Set<string> {
    const s = new Set<string>();
    for (const g of this.gates.values()) {
      if (g.executionRoleRef) s.add(parseRef(g.executionRoleRef).id);
    }
    return s;
  }

  // --------------------------------------------------------------- profiles

  registerCapabilityProfile(p: CapabilityProfile): void {
    if (p.composition !== 'intersect_only') throw new RegistryError('capability profile must be intersect_only');
    this.capProfiles.set(`${p.id}@${p.version}`, p);
  }

  getCapabilityProfile(ref: VersionedRef): CapabilityProfile {
    const p = this.capProfiles.get(ref) ?? this.latest(this.capProfiles, ref);
    if (!p) throw new RegistryError(`unknown capability profile: ${ref}`);
    return p;
  }

  registerGateProfile(p: GateProfile): void {
    if (p.composition !== 'union_only') throw new RegistryError('gate profile must be union_only');
    this.gateProfiles.set(`${p.id}@${p.version}`, p);
  }

  getGateProfile(ref: VersionedRef): GateProfile {
    const p = this.gateProfiles.get(ref) ?? this.latest(this.gateProfiles, ref);
    if (!p) throw new RegistryError(`unknown gate profile: ${ref}`);
    return p;
  }

  // ------------------------------------------------------------------ roles

  /**
   * Publication requires BOTH an eval-suite pass and human approval
   * (Note 01 §11 rule 5, Note 09 §6). Neither may be bypassed.
   */
  publishRole(r: RoleDef, opts: { evalPassed: boolean; approvedBy: string }): void {
    if (!opts.evalPassed) throw new RegistryError(`role ${r.id}: eval_suite must pass before publication`);
    if (!opts.approvedBy) throw new RegistryError(`role ${r.id}: human approval required for publication`);
    if (r.selfReportAccepted !== false) throw new RegistryError(`role ${r.id}: self_report_accepted must be false`);
    this.roles.set(`${r.id}@${r.version}`, r);
    this.auditLog.push({ at: new Date(0).toISOString(), action: 'publish_role', ref: `${r.id}@${r.version}`, by: opts.approvedBy });
  }

  getRole(ref: VersionedRef): RoleDef {
    const r = this.roles.get(ref) ?? this.latest(this.roles, ref);
    if (!r) throw new RegistryError(`unknown role: ${ref}`);
    if (r.status !== 'active') throw new RegistryError(`role not active: ${ref}`);
    return r;
  }

  hasRole(ref: VersionedRef): boolean {
    try { this.getRole(ref); return true; } catch { return false; }
  }

  // ---------------------------------------------------------------- recipes

  registerRecipe(r: ContextRecipe): void { this.recipes.set(`${r.id}@${r.version}`, r); }

  getRecipe(ref: VersionedRef): ContextRecipe {
    const r = this.recipes.get(ref) ?? this.latest(this.recipes, ref);
    if (!r) throw new RegistryError(`unknown recipe: ${ref}`);
    return r;
  }

  registerPrompt(ref: VersionedRef, text: string): void { this.prompts.set(ref, text); }

  getPrompt(ref: VersionedRef): string {
    const p = this.prompts.get(ref);
    if (p === undefined) throw new RegistryError(`unknown prompt: ${ref}`);
    return p;
  }

  private latest<T>(m: Map<string, T>, ref: string): T | undefined {
    if (m.has(ref)) return m.get(ref);
    const { id } = parseRef(ref);
    const keys = [...m.keys()].filter((k) => parseRef(k).id === id).sort();
    const last = keys[keys.length - 1];
    return last === undefined ? undefined : m.get(last);
  }
}

/**
 * Helper so fixtures can be authored without hand-computing signatures.
 * Strips any pre-existing signature first, so re-signing a derived object
 * signs the body rather than the body-plus-old-signature.
 */
export function signed<T extends object>(body: T): T & { signature: string } {
  const { signature: _drop, ...rest } = body as T & { signature?: string };
  return { ...(rest as T), signature: sign(rest) };
}

/** Run a gate's own fixtures. Registration-time and every-version check. */
export function runGateFixtures(g: GateDef, evaluate: (g: GateDef, artifact: unknown) => { verdict: string }): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  for (const f of g.fixtures.mustPass) {
    const r = evaluate(g, f.artifact);
    if (r.verdict !== f.expect) failures.push(`${g.id}: must_pass fixture '${f.name}' returned ${r.verdict}`);
  }
  for (const f of g.fixtures.mustFail) {
    const r = evaluate(g, f.artifact);
    if (r.verdict !== f.expect) failures.push(`${g.id}: must_fail fixture '${f.name}' returned ${r.verdict}`);
  }
  return { ok: failures.length === 0, failures };
}

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve as resolvePath, relative, sep } from 'node:path';
import type {
  CapabilityToken, CapabilityGrant, DenialRecord, DenialReason, ToolCallRecord,
  ModelCallRecord, ResolvedExecutionSpec, Money,
} from './types.ts';
import type { Registry } from './registry.ts';
import { hashOf, isExpired, nextId, now, plusSeconds, scopeContains } from './util.ts';

/**
 * Tool Broker and Model Broker (Note 07 §4–§8).
 *
 * The brokers hold the credentials the Executor does not. The Executor is the
 * only component running an untrusted model-driven loop, and consequently has
 * the FEWEST privileges — not the most.
 *
 * Enforcement lives here, in code. The prompt may describe constraints for the
 * model's benefit; the description is a courtesy and the broker is the boundary.
 */

export class BudgetExhausted extends Error {}

export function mintToken(spec: ResolvedExecutionSpec, attemptId: string, instanceId: string, workspaceRef: string, ttlSeconds: number): CapabilityToken {
  const issued = now();
  return {
    id: nextId('tok'),
    attemptId, instanceId, workspaceRef,
    grants: spec.effectiveCapabilities.capabilities,
    denies: spec.effectiveCapabilities.denies,
    issuedAt: issued,
    expiresAt: plusSeconds(issued, ttlSeconds),
    specHash: spec.hash,
  };
}

export interface ToolResultOk { readonly outcome: 'ok'; readonly value: unknown }
export interface ToolResultDenied { readonly outcome: 'denied'; readonly denial: DenialRecord }
export interface ToolResultError { readonly outcome: 'error'; readonly error: { readonly klass: string; readonly message: string } }
export type ToolResult = ToolResultOk | ToolResultDenied | ToolResultError;

export interface ToolCallReq {
  readonly toolId: string;
  readonly scope: string;
  readonly args: Record<string, unknown>;
}

export class ToolBroker {
  private readonly registry: Registry;
  private readonly workspaceRoot: string;
  private readonly denialBudget: number;
  private denials = 0;
  private seq = 0;
  private rate = new Map<string, number>();
  readonly records: ToolCallRecord[] = [];
  readonly denialRecords: DenialRecord[] = [];

  constructor(registry: Registry, workspaceRoot: string, denialBudget: number) {
    this.registry = registry;
    this.workspaceRoot = workspaceRoot;
    this.denialBudget = denialBudget;
  }

  denialsSpent(): number { return this.denials; }
  budgetExceeded(): boolean { return this.denials >= this.denialBudget; }

  call(req: ToolCallReq, token: CapabilityToken, specHash: string): ToolResult {
    const seq = ++this.seq;
    const started = Date.now();
    const finish = (outcome: 'ok' | 'denied' | 'error', extra: Partial<ToolCallRecord>): void => {
      this.records.push({
        seq, toolId: req.toolId, argsHash: hashOf(req.args), requestedScope: req.scope,
        outcome, scopeDecision: outcome === 'denied' ? 'denied' : 'granted',
        durationMs: Date.now() - started, ...extra,
      } as ToolCallRecord);
    };

    // Token verified on EVERY call, not once at start.
    if (token.specHash !== specHash) return this.deny(req, token, 'token_expired', finish);
    if (isExpired(token.expiresAt)) return this.deny(req, token, 'token_expired', finish);
    if (token.denies.includes(req.toolId)) return this.deny(req, token, 'explicitly_denied', finish);

    const grant = token.grants.find((g) => g.tool === req.toolId);
    if (!grant) return this.deny(req, token, 'not_granted', finish);
    if (!scopeContains(grant.scope, req.scope)) return this.deny(req, token, 'out_of_scope', finish);

    if (grant.rateLimit) {
      const used = (this.rate.get(req.toolId) ?? 0) + 1;
      this.rate.set(req.toolId, used);
      if (used > grant.rateLimit.calls) return this.deny(req, token, 'rate_limited', finish);
    }

    // Tool must be registered and signed; unsigned tools are unreachable.
    let tool;
    try { tool = this.registry.getTool(req.toolId); }
    catch (e) { finish('error', { }); return { outcome: 'error', error: { klass: 'unregistered_tool', message: String(e) } }; }

    try {
      const value = this.execute(tool.id, grant, req);
      finish('ok', { resultHash: hashOf(value ?? null) });
      return { outcome: 'ok', value };
    } catch (e) {
      finish('error', {});
      return { outcome: 'error', error: { klass: 'tool_fault', message: String(e) } };
    }
  }

  private deny(req: ToolCallReq, token: CapabilityToken, reason: DenialReason, finish: (o: 'denied', e: Partial<ToolCallRecord>) => void): ToolResultDenied {
    this.denials += 1;
    const denial: DenialRecord = {
      toolId: req.toolId,
      requestedScope: req.scope,
      reason,
      // Shown deliberately: a model that learns what it CAN reach adapts.
      grantedScopes: token.grants.map((g) => `${g.tool} ${g.scope}`),
      denialOrdinal: this.denials,
      budgetRemaining: Math.max(0, this.denialBudget - this.denials),
    };
    this.denialRecords.push(denial);
    finish('denied', { denialReason: reason });
    return { outcome: 'denied', denial };
  }

  /** Scope is expressed against logical roots; never absolute host paths. */
  private execute(toolId: string, _grant: CapabilityGrant, req: ToolCallReq): unknown {
    const rel = String(req.args['path'] ?? '');
    const abs = this.safeJoin(rel);
    switch (toolId) {
      case 'fs.read': return existsSync(abs) ? readFileSync(abs, 'utf8') : null;
      case 'fs.write': {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, String(req.args['content'] ?? ''), 'utf8');
        return { written: rel };
      }
      case 'fs.list': return listRepoFiles(this.workspaceRoot);
      case 'shell.exec': {
        const cmd = String(req.args['cmd'] ?? '');
        const out = execFileSync(process.platform === 'win32' ? 'cmd' : 'sh',
          process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd],
          { cwd: this.workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { stdout: out, exitCode: 0 };
      }
      case 'git.commit': {
        execFileSync('git', ['add', '-A'], { cwd: this.workspaceRoot });
        execFileSync('git', ['-c', 'user.email=x@y', '-c', 'user.name=slice01', 'commit', '-m', String(req.args['message'] ?? 'wip')], { cwd: this.workspaceRoot });
        return { committed: true };
      }
      default: throw new Error(`no implementation for tool ${toolId}`);
    }
  }

  /** Defence in depth: even a granted scope cannot escape the workspace root. */
  private safeJoin(rel: string): string {
    const abs = resolvePath(this.workspaceRoot, rel);
    const r = relative(this.workspaceRoot, abs);
    if (r.startsWith('..') || r.startsWith(sep + '..')) throw new Error('path escapes workspace root');
    return abs;
  }
}

export function listRepoFiles(root: string): string[] {
  const out = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  return out.trim() ? out.trim().split('\n') : [];
}

// ------------------------------------------------------------- model broker

export interface ModelProvider {
  readonly name: string;
  complete(req: { prompt: string; maxOutputTokens: number; samplingClass: string }): { text: string; inputTokens: number; outputTokens: number };
}

export interface SpendLedger {
  /**
   * Spend-point rule (Note 06 §6): decrement at the moment of spend, durably,
   * BEFORE the result returns. Never at attempt success. Otherwise a
   * crash-retry loop spends without bound and `fail_closed` is decorative.
   */
  record(attemptId: string, seq: number, cost: Money): void;
  spentFor(attemptId: string): Money;
  total(): Money;
}

export class InMemorySpendLedger implements SpendLedger {
  private rows: { attemptId: string; seq: number; cost: Money }[] = [];
  record(attemptId: string, seq: number, cost: Money): void {
    if (this.rows.some((r) => r.attemptId === attemptId && r.seq === seq)) return; // idempotent
    this.rows.push({ attemptId, seq, cost });
  }
  spentFor(attemptId: string): Money { return this.rows.filter((r) => r.attemptId === attemptId).reduce((a, r) => a + r.cost, 0); }
  total(): Money { return this.rows.reduce((a, r) => a + r.cost, 0); }
  snapshot(): readonly { attemptId: string; seq: number; cost: Money }[] { return this.rows; }
}

/**
 * The Executor holds NO model credentials and reaches the provider only here.
 * Combined with `network.egress: none`, that leaves no route off the box —
 * which is why brokering the model matters beyond metering.
 */
export class ModelBroker {
  private readonly providers: ModelProvider[];
  private readonly ledger: SpendLedger;
  private seq = 0;
  readonly records: ModelCallRecord[] = [];

  constructor(providers: ModelProvider[], ledger: SpendLedger) {
    this.providers = providers;
    this.ledger = ledger;
  }

  call(attemptId: string, spec: ResolvedExecutionSpec, prompt: string, ceiling: Money): { text: string } {
    const seq = ++this.seq;
    const started = Date.now();
    const spent = this.ledger.spentFor(attemptId);
    if (spent >= ceiling) {
      this.records.push({ seq, tierRequested: spec.modelBinding.tier, modelServed: 'none', inputTokens: 0, outputTokens: 0, cost: 0, durationMs: 0, outcome: 'budget_halt' });
      throw new BudgetExhausted(`execution budget exhausted: ${spent} >= ${ceiling}`);
    }

    // Ordered fallback across candidates; record which model ACTUALLY served.
    let lastErr: unknown = null;
    for (const candidate of spec.modelBinding.resolvedCandidates) {
      const provider = this.providers.find((p) => p.name === candidate);
      if (!provider) continue;
      try {
        const r = provider.complete({ prompt, maxOutputTokens: 4000, samplingClass: 'balanced' });
        const cost = round4(r.inputTokens * 0.000003 + r.outputTokens * 0.000015);
        this.ledger.record(attemptId, seq, cost);   // durable BEFORE returning
        this.records.push({ seq, tierRequested: spec.modelBinding.tier, modelServed: candidate, inputTokens: r.inputTokens, outputTokens: r.outputTokens, cost, durationMs: Date.now() - started, outcome: 'ok' });
        return { text: r.text };
      } catch (e) { lastErr = e; }
    }
    this.records.push({ seq, tierRequested: spec.modelBinding.tier, modelServed: 'none', inputTokens: 0, outputTokens: 0, cost: 0, durationMs: Date.now() - started, outcome: 'error' });
    throw new Error(`no model candidate served: ${String(lastErr)}`);
  }
}

function round4(n: number): number { return Math.round(n * 10000) / 10000; }

export function joinWorkspace(root: string, rel: string): string { return join(root, rel); }

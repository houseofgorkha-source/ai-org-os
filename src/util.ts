import { createHash, createHmac } from 'node:crypto';
import type { Hash, Timestamp } from './types.ts';

/** Canonical JSON: sorted keys, stable output. Basis for every content hash. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(input: string): Hash {
  return 'sha256:' + createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashOf(value: unknown): Hash {
  return sha256(canonical(value));
}

/**
 * Registry signing. A real deployment would use asymmetric keys held outside
 * any instance; slice 01 uses an HMAC with a key the kernel holds, which is
 * sufficient to prove the *mechanism* (verify-before-execute, no unsigned
 * reference) without pretending to solve key management.
 */
const REGISTRY_KEY = 'slice01-registry-key';

export function sign(payload: unknown): string {
  return createHmac('sha256', REGISTRY_KEY).update(canonical(payload), 'utf8').digest('hex');
}

export function verifySignature(payload: unknown, signature: string): boolean {
  return sign(payload) === signature;
}

/**
 * Kernel clock. The ONLY source of time for decisions (Note 06 §13).
 * Deterministic in tests so replay comparisons are meaningful.
 */
let clockTick = 0;
let clockBase = Date.UTC(2026, 7, 12, 9, 0, 0);

export function now(): Timestamp {
  clockTick += 1;
  return new Date(clockBase + clockTick * 1000).toISOString();
}

export function resetClock(baseMs?: number): void {
  clockTick = 0;
  if (baseMs !== undefined) clockBase = baseMs;
}

export function nowMs(): number {
  return clockBase + clockTick * 1000;
}

export function plusSeconds(ts: Timestamp, seconds: number): Timestamp {
  return new Date(Date.parse(ts) + seconds * 1000).toISOString();
}

export function isExpired(expiresAt: Timestamp): boolean {
  return nowMs() >= Date.parse(expiresAt);
}

/** Deterministic id generator — replay must reproduce ids exactly. */
const counters = new Map<string, number>();

export function nextId(prefix: string): string {
  const n = (counters.get(prefix) ?? 0) + 1;
  counters.set(prefix, n);
  return `${prefix}_${String(n).padStart(4, '0')}`;
}

export function resetIds(): void {
  counters.clear();
}

/** Crude but deterministic token estimate. Never wall-clock or model dependent. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function parseRef(ref: string): { id: string; version: string } {
  const at = ref.lastIndexOf('@');
  if (at === -1) return { id: ref, version: '' };
  return { id: ref.slice(0, at), version: ref.slice(at + 1) };
}

/**
 * Glob matching for scope and path predicates. Supports `**` and `*` only —
 * no regex, so evaluation is bounded (Note 08 §4).
 */
export function globMatch(pattern: string, path: string): boolean {
  const rx = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
  .replace(/\*\*/g, '.*')
  .replace(/\*/g, '[^/]*');
  return new RegExp('^' + rx + '$').test(path);
}

/** Scope containment: is `inner` fully within `outer`? Decidable; ambiguity denies. */
export function scopeContains(outer: string, inner: string): boolean {
  if (outer === inner) return true;
  const oRoot = outer.split('://')[0];
  const iRoot = inner.split('://')[0];
  if (oRoot !== iRoot) return false;
  const oPath = outer.slice((oRoot ?? '').length + 3);
  const iPath = inner.slice((iRoot ?? '').length + 3);
  if (oPath === '' || oPath === '**') return true;
  if (globMatch(oPath, iPath)) return true;
  if (oPath.endsWith('**')) return iPath.startsWith(oPath.slice(0, -2));
  return false;
}

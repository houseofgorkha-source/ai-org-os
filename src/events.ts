import { appendFileSync, existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { EventEnvelope, EventId, InstanceId } from './types.ts';
import { nextId, now } from './util.ts';

/**
 * Append-only event log (Note 06 §11).
 *
 * Every state transition is emitted here; all queryable state is a projection
 * (see projections.ts). No state exists that is not derivable from this stream.
 * Storage is deliberately a JSONL file — the *contract* is what slice 01 tests,
 * not the engine.
 */
export class EventStore {
  private readonly path: string;
  private buffer: EventEnvelope[] = [];

  constructor(path: string) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) writeFileSync(path, '');
    this.buffer = this.readAll();
  }

  append(e: Omit<EventEnvelope, 'eventId' | 'occurredAt'>): EventEnvelope {
    const full: EventEnvelope = { ...e, eventId: nextId('ev'), occurredAt: now() };
    appendFileSync(this.path, JSON.stringify(full) + '\n', 'utf8');
    this.buffer.push(full);
    return full;
  }

  readAll(): EventEnvelope[] {
    const raw = readFileSync(this.path, 'utf8');
    if (!raw.trim()) return [];
    return raw.trim().split('\n').map((l) => JSON.parse(l) as EventEnvelope);
  }

  /** In-memory view; identical to readAll() by construction. */
  all(): readonly EventEnvelope[] {
    return this.buffer;
  }

  byType(type: string): EventEnvelope[] {
    return this.buffer.filter((e) => e.type === type);
  }

  bySubject(ref: string): EventEnvelope[] {
    return this.buffer.filter((e) => e.subject.includes(ref));
  }

  /** Walk causation back to the root. T-K2. */
  causationChain(eventId: EventId): EventEnvelope[] {
    const byId = new Map(this.buffer.map((e) => [e.eventId, e]));
    const chain: EventEnvelope[] = [];
    let cur = byId.get(eventId);
    while (cur) {
      chain.push(cur);
      cur = cur.causationId ? byId.get(cur.causationId) : undefined;
    }
    return chain.reverse();
  }

  /** Per-unit total order (Note 06 §12). Global order is deliberately NOT required. */
  orderedFor(subjectRef: string): EventEnvelope[] {
    return this.bySubject(subjectRef);
  }
}

export function makeEvent(
  instanceId: InstanceId,
  type: string,
  actor: string,
  subject: string[],
  payload: Record<string, unknown>,
  causationId: EventId | null = null,
  correlationId: string | null = null,
): Omit<EventEnvelope, 'eventId' | 'occurredAt'> {
  return { instanceId, type, actor, subject, payload, causationId, correlationId };
}

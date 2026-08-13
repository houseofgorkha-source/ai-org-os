import { globMatch } from './util.ts';

/**
 * The predicate language (Note 08).
 *
 * Total, deterministic, three-valued. No recursion, no loops, no regex, no I/O,
 * no clock. Termination is STRUCTURAL, never a timeout — predicates run inside
 * pre-dispatch validation where determinism is required.
 *
 * The fact surface is a WHITELIST: there is no expression that reaches a
 * `private` segment, a memory source, raw file contents, another instance, or
 * the clock, because no fact naming any of those exists.
 */

export type Tri = 'true' | 'false' | 'unknown';

/** Artifact fact surface — serves gate `applies_when` AND class promotion. */
export interface ArtifactFacts {
  readonly 'artifact.type': string;
  readonly 'artifact.schema_ref': string;
  readonly 'artifact.segments': readonly string[];   // non-private names only
  readonly 'diff.paths': readonly string[];
  readonly 'diff.files_touched': number;
  readonly 'diff.insertions': number;
  readonly 'diff.deletions': number;
  readonly 'diff.modifies_public_interface': boolean;
  readonly 'diff.dependency_manifest_changed': boolean;
  readonly 'unit.class': string;
  readonly 'unit.role_ref': string;
  readonly 'unit.affected_paths': readonly string[];
}

export type Facts = Partial<Record<string, unknown>>;

/** Consumers resolve `unknown` in their own conservative direction (Note 08 §6). */
export type UnknownPolicy = 'applies' | 'promote' | 'exclude';

export function resolveTri(t: Tri, policy: UnknownPolicy): boolean {
  if (t === 'true') return true;
  if (t === 'false') return false;
  // unknown: gates apply, promotions promote, memory/recipes exclude
  return policy === 'applies' || policy === 'promote';
}

// ------------------------------------------------------------------- lexing

type Tok = { k: 'id' | 'str' | 'num' | 'op' | 'lp' | 'rp'; v: string };

function lex(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(') { out.push({ k: 'lp', v: '(' }); i++; continue; }
    if (c === ')') { out.push({ k: 'rp', v: ')' }); i++; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1; let s = '';
      while (j < src.length && src[j] !== c) { s += src[j]; j++; }
      if (j >= src.length) throw new Error('unterminated string');
      out.push({ k: 'str', v: s }); i = j + 1; continue;
    }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '!=' || two === '<=' || two === '>=') { out.push({ k: 'op', v: two }); i += 2; continue; }
    if (c === '<' || c === '>') { out.push({ k: 'op', v: c }); i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i; let s = '';
      while (j < src.length && /[0-9.]/.test(src[j]!)) { s += src[j]; j++; }
      out.push({ k: 'num', v: s }); i = j; continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i; let s = '';
      while (j < src.length && /[A-Za-z0-9_.]/.test(src[j]!)) { s += src[j]; j++; }
      out.push({ k: 'id', v: s }); i = j; continue;
    }
    throw new Error(`unexpected character '${c}' in predicate`);
  }
  return out;
}

// ------------------------------------------------------------------ parsing

type Node =
  | { t: 'and'; l: Node; r: Node }
  | { t: 'or'; l: Node; r: Node }
  | { t: 'not'; e: Node }
  | { t: 'cmp'; op: string; l: Node; r: Node }
  | { t: 'call'; fn: string; args: Node[] }
  | { t: 'fact'; name: string }
  | { t: 'lit'; v: string | number | boolean };

const FUNCS = new Set(['matches', 'under', 'in', 'subset_of', 'intersects', 'empty', 'contains', 'overlaps']);

class Parser {
  private i = 0;
  private readonly toks: Tok[];
  constructor(toks: Tok[]) { this.toks = toks; }
  private peek(): Tok | undefined { return this.toks[this.i]; }
  private next(): Tok { const t = this.toks[this.i]; if (!t) throw new Error('unexpected end of predicate'); this.i++; return t; }

  parse(): Node {
    const n = this.orExpr();
    if (this.i !== this.toks.length) throw new Error('trailing tokens in predicate');
    return n;
  }
  private orExpr(): Node {
    let l = this.andExpr();
    while (this.peek()?.k === 'id' && this.peek()!.v === 'or') { this.next(); l = { t: 'or', l, r: this.andExpr() }; }
    return l;
  }
  private andExpr(): Node {
    let l = this.unary();
    while (this.peek()?.k === 'id' && this.peek()!.v === 'and') { this.next(); l = { t: 'and', l, r: this.unary() }; }
    return l;
  }
  private unary(): Node {
    if (this.peek()?.k === 'id' && this.peek()!.v === 'not') { this.next(); return { t: 'not', e: this.unary() }; }
    return this.cmp();
  }
  private cmp(): Node {
    const l = this.primary();
    const p = this.peek();
    if (p?.k === 'op') { this.next(); return { t: 'cmp', op: p.v, l, r: this.primary() }; }
    if (p?.k === 'id' && FUNCS.has(p.v) && p.v !== 'empty') {
      this.next();
      return { t: 'call', fn: p.v, args: [l, this.primary()] };
    }
    return l;
  }
  private primary(): Node {
    const t = this.next();
    if (t.k === 'lp') { const e = this.orExpr(); const r = this.next(); if (r.k !== 'rp') throw new Error('expected )'); return e; }
    if (t.k === 'str') return { t: 'lit', v: t.v };
    if (t.k === 'num') return { t: 'lit', v: Number(t.v) };
    if (t.k === 'id') {
      if (t.v === 'true') return { t: 'lit', v: true };
      if (t.v === 'false') return { t: 'lit', v: false };
      if (FUNCS.has(t.v) && this.peek()?.k === 'lp') {
        this.next();
        const args: Node[] = [];
        while (this.peek()?.k !== 'rp') {
          args.push(this.orExpr());
          if (this.peek()?.k === 'id' && this.peek()!.v === 'and') break;
        }
        const r = this.next(); if (r.k !== 'rp') throw new Error('expected )');
        return { t: 'call', fn: t.v, args };
      }
      return { t: 'fact', name: t.v };
    }
    throw new Error(`unexpected token '${t.v}'`);
  }
}

export function parsePredicate(src: string): Node {
  return new Parser(lex(src)).parse();
}

// --------------------------------------------------------------- evaluation

const UNKNOWN = Symbol('unknown');
type Val = string | number | boolean | readonly string[] | typeof UNKNOWN;

function evalNode(n: Node, facts: Facts): Val {
  switch (n.t) {
    case 'lit': return n.v;
    case 'fact': {
      if (!(n.name in facts)) return UNKNOWN;      // unresolvable ⇒ unknown, NOT false
      const v = facts[n.name];
      return v === undefined ? UNKNOWN : (v as Val);
    }
    case 'not': {
      const e = evalNode(n.e, facts);
      if (e === UNKNOWN) return UNKNOWN;
      return !truthy(e);
    }
    case 'and': {
      const l = evalNode(n.l, facts); const r = evalNode(n.r, facts);
      if (l !== UNKNOWN && !truthy(l)) return false;
      if (r !== UNKNOWN && !truthy(r)) return false;   // unknown AND false = false
      if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
      return true;
    }
    case 'or': {
      const l = evalNode(n.l, facts); const r = evalNode(n.r, facts);
      if (l !== UNKNOWN && truthy(l)) return true;
      if (r !== UNKNOWN && truthy(r)) return true;     // unknown OR true = true
      if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
      return false;
    }
    case 'cmp': {
      const l = evalNode(n.l, facts); const r = evalNode(n.r, facts);
      if (l === UNKNOWN || r === UNKNOWN) return UNKNOWN;
      switch (n.op) {
        case '==': return String(l) === String(r);
        case '!=': return String(l) !== String(r);
        case '<': return Number(l) < Number(r);
        case '<=': return Number(l) <= Number(r);
        case '>': return Number(l) > Number(r);
        case '>=': return Number(l) >= Number(r);
        default: throw new Error(`unknown operator ${n.op}`);
      }
    }
    case 'call': {
      const args = n.args.map((a) => evalNode(a, facts));
      if (args.some((a) => a === UNKNOWN)) return UNKNOWN;
      const [a0, a1] = args as [Val, Val];
      switch (n.fn) {
        case 'matches': {
          const set = Array.isArray(a0) ? a0 : [String(a0)];
          return set.some((p) => globMatch(String(a1), p));
        }
        case 'under': {
          const set = Array.isArray(a0) ? a0 : [String(a0)];
          return set.some((p) => p.startsWith(String(a1)));
        }
        case 'in': {
          const set = Array.isArray(a1) ? a1 : [String(a1)];
          return set.includes(String(a0));
        }
        case 'subset_of': {
          const l = Array.isArray(a0) ? a0 : [String(a0)];
          const r = Array.isArray(a1) ? a1 : [String(a1)];
          return l.every((x) => r.includes(x));
        }
        case 'intersects':
        case 'overlaps': {
          const l = Array.isArray(a0) ? a0 : [String(a0)];
          const r = Array.isArray(a1) ? a1 : [String(a1)];
          return l.some((x) => r.some((y) => x === y || globMatch(y, x) || globMatch(x, y)));
        }
        case 'contains': {
          const l = Array.isArray(a0) ? a0 : [String(a0)];
          return l.includes(String(a1));
        }
        case 'empty': return Array.isArray(a0) ? a0.length === 0 : String(a0).length === 0;
        default: throw new Error(`unknown function ${n.fn}`);
      }
    }
  }
}

function truthy(v: Val): boolean {
  if (v === UNKNOWN) return false;
  if (Array.isArray(v)) return v.length > 0;
  return Boolean(v);
}

export function evaluate(src: string, facts: Facts): Tri {
  const v = evalNode(parsePredicate(src), facts);
  if (v === UNKNOWN) return 'unknown';
  return truthy(v) ? 'true' : 'false';
}

// ----------------------------------------------------------- coverage (C5)

export interface CoverageReport {
  readonly pathTerms: readonly string[];
  readonly matchedTerms: readonly string[];
  readonly zeroMatchTerms: readonly string[];
  readonly verdict: 'covered' | 'partial' | 'ZERO_COVERAGE';
}

function collectLiterals(n: Node, out: string[]): void {
  switch (n.t) {
    case 'lit': if (typeof n.v === 'string') out.push(n.v); return;
    case 'not': collectLiterals(n.e, out); return;
    case 'and': case 'or': case 'cmp': collectLiterals(n.l, out); collectLiterals(n.r, out); return;
    case 'call': for (const a of n.args) collectLiterals(a, out); return;
    default: return;
  }
}

/**
 * Static analysis, run at policy publication and on repository change (C5).
 *
 * A renamed subsystem does NOT produce `unknown` — the fact surface resolves and
 * the glob simply matches nothing, returning `false` forever. Only this catches
 * that. `unknown` and ZERO_COVERAGE are different mechanisms; neither
 * substitutes for the other.
 */
export function coverage(src: string, repoPaths: readonly string[]): CoverageReport {
  const lits: string[] = [];
  collectLiterals(parsePredicate(src), lits);
  const pathTerms = lits.filter((l) => l.includes('/') || l.includes('*'));
  const matched = pathTerms.filter((t) => repoPaths.some((p) => globMatch(t, p) || p.startsWith(t.replace(/\*+$/, ''))));
  const zero = pathTerms.filter((t) => !matched.includes(t));
  const verdict = pathTerms.length === 0 ? 'covered'
    : zero.length === pathTerms.length ? 'ZERO_COVERAGE'
    : zero.length > 0 ? 'partial' : 'covered';
  return { pathTerms, matchedTerms: matched, zeroMatchTerms: zero, verdict };
}

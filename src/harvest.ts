import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Artifact, WorkUnit, Segment, ArtifactId, AttemptId } from './types.ts';
import { globMatch, hashOf, nextId, now, sha256 } from './util.ts';

/**
 * Kernel-side harvest (Note 07 §3).
 *
 * The artifact is DERIVED FROM THE WORKSPACE by the kernel. It is never
 * REPORTED BY the executor. An executor that constructs its own artifact can
 * omit a file or describe a diff that differs from the workspace it left
 * behind; deriving it removes the option.
 *
 * Harvest is a deterministic function of (workspace, baseline), which is what
 * makes crash recovery nearly free (T-K6).
 */

export interface HarvestInput {
  readonly workspaceRoot: string;
  readonly baselineCommit: string;
  readonly unit: WorkUnit;
  readonly attemptId: AttemptId;
  readonly contextManifestRef: string;
}

export interface HarvestOutput {
  readonly artifact: Artifact;
  readonly outOfScopePaths: readonly string[];
  readonly filesTouched: number;
  readonly insertions: number;
  readonly deletions: number;
}

/** Freeze: make the workspace read-only at the instant the executor exits. */
export function freezeWorkspace(root: string): void {
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === '.git') continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { chmodSync(p, 0o444); } catch { /* best effort on win32 */ } }
    }
  };
  if (existsSync(root)) walk(root);
}

export function isFrozen(root: string, rel: string): boolean {
  const p = join(root, rel);
  if (!existsSync(p)) return false;
  const mode = statSync(p).mode & 0o222;
  return mode === 0;
}

export function harvest(input: HarvestInput): HarvestOutput {
  const { workspaceRoot, baselineCommit, unit } = input;

  execFileSync('git', ['add', '-A'], { cwd: workspaceRoot });
  const nameStatus = git(workspaceRoot, ['diff', '--cached', '--name-only', baselineCommit]);
  const numstat = git(workspaceRoot, ['diff', '--cached', '--numstat', baselineCommit]);
  const patch = git(workspaceRoot, ['diff', '--cached', baselineCommit]);

  const paths = nameStatus.trim() ? nameStatus.trim().split('\n').map((s) => s.trim()) : [];
  let insertions = 0; let deletions = 0;
  for (const line of numstat.trim() ? numstat.trim().split('\n') : []) {
    const [a, d] = line.split('\t');
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
  }

  // Scope check. Out-of-scope paths are SURFACED AND FLAGGED, never filtered —
  // silent filtering hides a scope violation, and a scope violation is one of
  // the highest-signal indicators that a unit misunderstood its objective.
  const outOfScope = paths.filter((p) => !unit.affectedPaths.some((g) => globMatch(g, p)));

  const publicSegs: Segment[] = [
    seg('diff', 'public', patch),
    seg('files_touched', 'public', paths),
    seg('gate_evidence', 'public', { insertions, deletions, outOfScope }),
    seg('test_provenance', 'public', detectTestProvenance(patch)),
  ];
  const restricted: Segment[] = [seg('implementation_notes', 'restricted', '')];
  // PRIVATE segments exist but are unaddressable by any recipe or predicate.
  const priv: Segment[] = [
    seg('reasoning_trace', 'private', `trace:${input.attemptId}`),
    seg('self_assessment', 'private', null),
  ];
  const segments = [...publicSegs, ...restricted, ...priv];

  const artifact: Artifact = {
    id: nextId('art'),
    instanceId: unit.instanceId,
    type: 'CodeDiff',
    schemaRef: 'schema://code_diff/1.0.0',
    contentHash: sha256(patch + '\n' + paths.join(',')),
    createdAt: now(),
    segments,
    producedBy: {
      workUnitId: unit.id,
      attemptId: input.attemptId,
      roleRef: unit.executionSpec.roleRef,
      executionSpecHash: unit.executionSpec.hash,
    },
    inputsHash: hashOf(unit.inputs),
    contextManifestRef: input.contextManifestRef,
    status: 'draft',
  };

  return { artifact, outOfScopePaths: outOfScope, filesTouched: paths.length, insertions, deletions };
}

function seg(name: string, visibility: Segment['visibility'], content: unknown): Segment {
  return { name, visibility, content, hash: hashOf(content) };
}

function detectTestProvenance(patch: string): { addedTests: number; flagged: string } {
  const added = (patch.match(/^\+.*\b(test|it|describe)\s*\(/gm) ?? []).length;
  return { addedTests: added, flagged: 'implementer-authored' };
}

export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Artifact construction is idempotent under (unit, attempt, contentHash). */
export function dedupeArtifact(existing: readonly Artifact[], candidate: Artifact): { artifact: Artifact; created: boolean } {
  const found = existing.find((a) =>
    a.producedBy.workUnitId === candidate.producedBy.workUnitId &&
    a.producedBy.attemptId === candidate.producedBy.attemptId &&
    a.contentHash === candidate.contentHash);
  return found ? { artifact: found, created: false } : { artifact: candidate, created: true };
}

export type { ArtifactId };

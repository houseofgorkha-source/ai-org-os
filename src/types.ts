/**
 * AI-Org OS — Slice 01 core types.
 *
 * Erasable-only TypeScript (no enums, no namespaces, no parameter properties)
 * so Node can run these directly via type stripping.
 *
 * NOTE: several checklist tests are TYPE-LEVEL assertions against this file
 * (T-I1: FailureRecord has no narrative field; T-F7: ExecutorResult has no
 * artifact/verdict/status/cost). Adding such a field here fails those tests at
 * `tsc --noEmit`, which is the intended enforcement point.
 */

// ---------------------------------------------------------------- primitives

export type Hash = string;
export type Timestamp = string; // ISO-8601, kernel-assigned (Note 06 §13)
export type Money = number;     // USD, 4dp

export type InstanceId = string;
export type IntentId = string;
export type PlanId = string;
export type WorkUnitId = string;
export type AttemptId = string;
export type ArtifactId = string;
export type ApprovalId = string;
export type EventId = string;
export type TokenId = string;
export type WorkspaceRef = string;
export type ManifestId = string;

/** `id@semver` */
export type VersionedRef = string;

// ------------------------------------------------------------------ registry

export type ToolEffects = 'read' | 'write' | 'execute' | 'external';
export type ToolMode = 'read' | 'write' | 'execute';
export type LifecycleStatus = 'draft' | 'active' | 'deprecated' | 'retired';

export interface ToolFixture {
  readonly name: string;
  readonly call: { readonly args: Record<string, unknown>; readonly scope: string };
  readonly expect: 'ok' | 'denied' | 'error';
}

export interface ToolDef {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly status: LifecycleStatus;
  readonly effects: ToolEffects;
  readonly scopeKinds: readonly string[];
  readonly credentialScopes: readonly string[];
  readonly sandbox: { readonly network: 'none' | 'allowlist'; readonly determinism: boolean };
  readonly fixtures: {
    readonly mustSucceed: readonly ToolFixture[];
    readonly mustDeny: readonly ToolFixture[];   // E4.4 — mandatory
    readonly mustError: readonly ToolFixture[];
  };
  readonly signature: string;
}

export type CriterionClass = 'C0' | 'C1' | 'C2' | 'C3';
export type GateKind = 'deterministic' | 'empirical' | 'model_judged' | 'human';
export type GateVerdict = 'pass' | 'fail' | 'indeterminate' | 'error';

export interface GateFixture {
  readonly name: string;
  readonly artifact: unknown;
  readonly expect: GateVerdict;
}

/** Closed enumeration. D3: may never include a memory source. */
export type GateContextSource =
  | 'workspace_snapshot'
  | 'baseline_artifact'
  | 'constraint_refs'
  | 'runtime_environment';

export interface GateDef {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly status: LifecycleStatus;
  readonly kind: GateKind;
  readonly criterionClass: CriterionClass;
  readonly appliesTo: readonly string[];
  readonly appliesWhen?: string;              // predicate source (Note 08)
  readonly requiresSegments: readonly string[];
  readonly requiresContext: readonly GateContextSource[];
  readonly passMeans: string;                 // mandatory (Note 03 §2)
  readonly failMeans: string;
  readonly costClass: 'free' | 'cheap' | 'moderate' | 'expensive';
  readonly stage: number;
  readonly determinism: boolean;
  readonly auditOnly: boolean;
  readonly flake?: { readonly maxRuns: number; readonly quorum: string };
  readonly fixtures: {
    readonly mustPass: readonly GateFixture[];
    readonly mustFail: readonly GateFixture[]; // Note 03 §8 — mandatory
  };
  readonly signature: string;
}

export interface CapabilityGrant {
  readonly tool: string;
  readonly scope: string;
  readonly mode: ToolMode;
  readonly rateLimit?: { readonly calls: number; readonly windowS: number };
}

export interface CapabilityProfile {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly composition: 'intersect_only';
  readonly capabilities: readonly CapabilityGrant[];
  readonly capabilityDenies: readonly string[];
  readonly permissions: {
    readonly network: { readonly egress: 'none' | 'allowlist' };
    readonly repository: { readonly mode: 'none' | 'read' | 'worktree_write'; readonly mayCommit: boolean; readonly mayPush: boolean };
    readonly secrets: { readonly scopes: readonly string[] };
    readonly data: { readonly dbAccess: 'none' | 'read_replica' | 'read_write'; readonly rowScope: 'instance_only' };
    readonly externalEffects: { readonly maySend: boolean; readonly mayDeploy: boolean; readonly maySpend: boolean };
  };
}

export interface GateBinding {
  readonly gateRef: VersionedRef;
  readonly blocking: boolean;
  readonly order: number;
  readonly parameters?: Record<string, unknown>;
}

export interface GateProfile {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly composition: 'union_only';
  readonly bindings: readonly GateBinding[];
}

export interface RoleDef {
  readonly id: string;
  readonly version: string;
  readonly owner: string;
  readonly status: LifecycleStatus;
  readonly mandate: string;
  readonly consumes: readonly string[];
  readonly produces: string;
  readonly emitsPlan: boolean;
  readonly model: {
    readonly tier: 'frontier' | 'standard' | 'fast';
    readonly pinning: 'pinned' | 'floating_within_tier';
    readonly reasoningEffort: 'low' | 'medium' | 'high' | 'max';
    readonly samplingClass: 'deterministic' | 'balanced' | 'exploratory';
    readonly maxOutputTokens: number;
  };
  readonly contextRecipeRef: VersionedRef;
  readonly contextBudgetTokens: number;
  readonly capabilityProfileRef: VersionedRef;
  readonly gateProfileRef: VersionedRef;
  readonly promptRef: VersionedRef;
  readonly evalSuiteRef: VersionedRef;
  readonly onFailure: Record<string, string>;
  readonly budget: {
    readonly perAttempt: { readonly costCeiling: Money; readonly wallClockS: number; readonly toolCalls: number };
    readonly perWorkUnit: { readonly maxAttempts: number; readonly filesTouched: number };
  };
  readonly selfReportAccepted: false;
  readonly artifactSchema: string;
}

// ------------------------------------------------------------------- context

export type AuthorityTier = 'ground-truth' | 'contract' | 'policy' | 'advisory';

export interface RecipeLayer {
  readonly name: string;
  readonly source: string;
  readonly authority: AuthorityTier;
  readonly priority: number;
  readonly maxTokens: number;
  readonly required: boolean;
  readonly onMiss: 'fail' | 'omit';
}

export interface ContextRecipe {
  readonly id: string;
  readonly version: string;
  readonly totalBudgetTokens: number;
  readonly layers: readonly RecipeLayer[];
  readonly overflowPolicy: 'fail' | 'truncate_by_priority';
}

export interface RenderedLayer {
  readonly name: string;
  readonly authority: AuthorityTier;
  readonly provenance: string;
  readonly marks: readonly string[];
  readonly body: string;
  readonly tokens: number;
  readonly truncated?: { readonly omitted: number; readonly of: number; readonly unit: string; readonly policy: string };
}

export interface ContextManifest {
  readonly id: ManifestId;
  readonly recipeRef: VersionedRef;
  readonly layers: readonly {
    readonly name: string;
    readonly hash: Hash;
    readonly sourceVersion: string;
    readonly tokens: number;
    readonly truncated: boolean;
  }[];
  readonly memory: {
    readonly candidateSet: readonly { readonly id: string; readonly version: string }[];
    readonly included: readonly { readonly id: string; readonly version: string; readonly mark: 'verified' | 'unverified' }[];
    readonly dropped: readonly { readonly id: string; readonly version: string; readonly reason: string }[];
  };
  readonly totalTokens: number;
  readonly assembledHash: Hash;   // over the RENDERED output (E2 rule 4)
  readonly compiledAt: Timestamp;
}

// ------------------------------------------------------------------ contract

export interface Criterion {
  readonly id: string;
  readonly statement: string;
  readonly klass: CriterionClass;
  /** B1 + B9: ALL classes bind a gate. There is no `verifierRole`, no `approver`. */
  readonly check: {
    readonly gateRef: VersionedRef;
    readonly parameters?: Record<string, unknown>;
  };
  readonly blocking: boolean;
  readonly derivedFrom?: string;
}

export type WorkUnitClass = 'mechanical_change' | 'bounded_change' | 'contract_change' | 'investigation';

export type WorkUnitStatus =
  | 'draft' | 'validated' | 'invalid' | 'ready' | 'blocked' | 'running'
  | 'verifying' | 'attempt_failed' | 'awaiting_approval' | 'accepted'
  | 'rejected' | 'exhausted' | 'escalated' | 'cancelled';

export interface EffectiveBudget {
  readonly execution: { readonly costCeiling: Money; readonly wallClockS: number; readonly toolCalls: number };
  readonly verification: { readonly cost: Money; readonly wallClockS: number; readonly modelGateCalls: number };
  readonly maxAttempts: number;
  readonly filesTouched: number;
}

export interface ResolvedExecutionSpec {
  readonly hash: Hash;
  readonly roleRef: VersionedRef;
  readonly promptRef: VersionedRef;
  readonly contextRecipeRef: VersionedRef;
  readonly artifactSchemaRef: string;
  readonly effectiveCapabilities: {
    readonly resolvedFrom: readonly string[];
    readonly capabilities: readonly CapabilityGrant[];
    readonly denies: readonly string[];
    readonly permissions: CapabilityProfile['permissions'];
  };
  readonly effectiveGates: { readonly resolvedFrom: readonly string[]; readonly bindings: readonly GateBinding[] };
  readonly effectiveBudget: EffectiveBudget;
  readonly modelBinding: { readonly tier: string; readonly resolvedCandidates: readonly string[]; readonly bindingRef: string };
  readonly onFailure: Record<string, string>;
}

export interface PlanNode {
  readonly nodeId: string;
  readonly objective: string;
  readonly roleRef: VersionedRef;
  readonly klass: WorkUnitClass;
  readonly expectedOutput: string;
  readonly acceptanceCriteria: readonly Criterion[];
  readonly constraints: readonly { readonly sourceArtifact?: ArtifactId; readonly constraintIds: readonly string[] }[];
  readonly affectedPaths: readonly string[];
  readonly budget: { readonly execution: Money; readonly verification: Money };
  readonly approvalsRequired: readonly { readonly kind: string; readonly subject: string; readonly blocking: boolean }[];
}

export type PlanEdgeKind = 'artifact' | 'ordering'; // `resource` is DERIVED (E1.3)

export interface TaskPlan {
  readonly id: PlanId;
  readonly version: string;
  readonly instanceId: InstanceId;
  readonly intentRef: IntentId;
  readonly supersedes?: string;
  readonly replanReason?: { readonly triggeredBy: string; readonly summary: string };
  readonly nodes: readonly PlanNode[];
  readonly edges: readonly { readonly from: string; readonly to: string; readonly kind: PlanEdgeKind }[];
  readonly budgetAggregate: { readonly execution: Money; readonly verification: Money };
  readonly status: 'draft' | 'approved' | 'running' | 'complete' | 'partial' | 'cancelled';
}

export interface WorkUnit {
  readonly id: WorkUnitId;
  readonly instanceId: InstanceId;
  readonly planId: PlanId;
  readonly planVersion: string;
  readonly planNodeId: string;
  readonly klass: WorkUnitClass;
  readonly objective: string;
  readonly intentRef: IntentId;
  readonly inputs: readonly { readonly artifactId: ArtifactId; readonly contentHash: Hash; readonly as: string; readonly segments: readonly string[] }[];
  readonly expectedOutput: string;
  readonly acceptanceCriteria: readonly Criterion[];
  readonly constraints: readonly { readonly sourceArtifact?: ArtifactId; readonly constraintIds: readonly string[] }[];
  readonly executionSpec: ResolvedExecutionSpec;
  readonly dependsOn: readonly { readonly unitId: WorkUnitId; readonly kind: PlanEdgeKind }[];
  readonly affectedPaths: readonly string[];
  readonly budget: EffectiveBudget;
  readonly approvalsRequired: readonly { readonly kind: string; readonly subject: string; readonly blocking: boolean }[];
  readonly baselineCommit: string;
}

// ------------------------------------------------------------------ artifact

export type SegmentVisibility = 'public' | 'restricted' | 'private';
export type ArtifactStatus = 'draft' | 'verified' | 'accepted' | 'rejected' | 'superseded' | 'abandoned';

export interface Segment {
  readonly name: string;
  readonly visibility: SegmentVisibility;
  readonly content: unknown;
  readonly hash: Hash;
}

export interface Artifact {
  readonly id: ArtifactId;
  readonly instanceId: InstanceId;
  readonly type: string;
  readonly schemaRef: string;
  readonly contentHash: Hash;
  readonly createdAt: Timestamp;
  readonly segments: readonly Segment[];
  readonly producedBy: {
    readonly workUnitId: WorkUnitId | null;
    readonly attemptId: AttemptId | null;
    readonly roleRef: VersionedRef | null;
    readonly executionSpecHash: Hash | null;
  };
  readonly inputsHash: Hash;
  readonly contextManifestRef: ManifestId | null;
  readonly status: ArtifactStatus;
}

// ------------------------------------------------------------------- attempt

export type AttemptStatus =
  | 'running' | 'completed' | 'failed' | 'timed_out'
  | 'denied' | 'budget_exhausted' | 'cancelled' | 'superseded';

export type DenialReason =
  | 'not_granted' | 'out_of_scope' | 'rate_limited' | 'explicitly_denied' | 'token_expired';

export interface DenialRecord {
  readonly toolId: string;
  readonly requestedScope: string;
  readonly reason: DenialReason;
  readonly grantedScopes: readonly string[];  // shown deliberately (Note 07 §7)
  readonly denialOrdinal: number;
  readonly budgetRemaining: number;
}

export interface ToolCallRecord {
  readonly seq: number;
  readonly toolId: string;
  readonly argsHash: Hash;
  readonly requestedScope: string;
  readonly outcome: 'ok' | 'denied' | 'error';
  readonly scopeDecision: 'granted' | 'denied';
  readonly denialReason?: DenialReason;
  readonly resultHash?: Hash;
  readonly durationMs: number;
}

export interface ModelCallRecord {
  readonly seq: number;
  readonly tierRequested: string;
  readonly modelServed: string;   // ACTUAL, incl. fallback (Note 07 §14)
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cost: Money;
  readonly durationMs: number;
  readonly outcome: 'ok' | 'refused' | 'error' | 'budget_halt';
}

export interface Attempt {
  readonly id: AttemptId;
  readonly workUnitId: WorkUnitId;
  readonly ordinal: number;
  readonly leaseEpoch: number;
  readonly startedAt: Timestamp;
  readonly endedAt: Timestamp | null;
  readonly executionSpecHash: Hash;
  readonly contextManifestRef: ManifestId | null;
  readonly renderedPromptHash: Hash | null;
  readonly capabilityTokenRef: TokenId | null;
  readonly workspaceRef: WorkspaceRef | null;
  readonly toolInvocations: readonly ToolCallRecord[];
  readonly modelInvocations: readonly ModelCallRecord[];
  readonly status: AttemptStatus;
  readonly producedArtifact: ArtifactId | null;
  readonly rawTraceRef: string | null;   // PRIVATE. Unaddressable by any recipe.
}

// -------------------------------------------------------------- executor I/O

export interface ExecutorInvocation {
  readonly attemptId: AttemptId;
  readonly workUnitId: WorkUnitId;
  readonly executionSpec: ResolvedExecutionSpec;
  readonly renderedContext: string;
  readonly contextManifestRef: ManifestId;
  readonly capabilityToken: CapabilityToken;
  readonly workspaceRef: WorkspaceRef;
  readonly deadline: Timestamp;
}

export type ExecutorTermination =
  | 'completed' | 'model_refused' | 'deadline' | 'denial_budget' | 'tool_fault' | 'internal_error';

/**
 * T-F7 (type-level): this type MUST NOT gain `artifact`, `verdict`, `status`,
 * `cost`, `consumption`, or any success claim. The kernel derives all of those.
 */
export interface ExecutorResult {
  readonly attemptId: AttemptId;
  readonly termination: ExecutorTermination;
  readonly toolInvocations: readonly ToolCallRecord[];
  readonly modelInvocations: readonly ModelCallRecord[];
  readonly narrative: string;   // PRIVATE, debugging only
}

export interface CapabilityToken {
  readonly id: TokenId;
  readonly attemptId: AttemptId;
  readonly instanceId: InstanceId;
  readonly workspaceRef: WorkspaceRef;
  readonly grants: readonly CapabilityGrant[];
  readonly denies: readonly string[];
  readonly issuedAt: Timestamp;
  readonly expiresAt: Timestamp;
  readonly specHash: Hash;
}

// ---------------------------------------------------------------- gate result

export type EvidenceKind =
  | 'assertion' | 'diff_projection' | 'command_output' | 'metric' | 'location' | 'finding' | 'reproduction';

export interface Evidence {
  readonly kind: EvidenceKind;
  readonly content: string;
  readonly location?: string;
  readonly visibility: SegmentVisibility;   // derived: max of what it quotes
}

export interface GateResult {
  readonly id: string;
  readonly gateRef: VersionedRef;
  readonly subject: { readonly artifactId: ArtifactId; readonly contentHash: Hash };
  readonly decides: readonly string[];
  readonly verdict: GateVerdict;
  readonly blocking: boolean;
  readonly decidedAt: Timestamp;
  readonly durationMs: number;
  readonly cost: Money;
  readonly evidence: readonly Evidence[];
  readonly determinismHash?: Hash;
  readonly runs?: readonly GateVerdict[];
}

// ------------------------------------------------------------- failure record

export type FailureClass =
  | 'spec_ambiguous' | 'verification_failed' | 'constraint_violated'
  | 'tool_error' | 'budget_exceeded' | 'no_progress'
  | 'schema_invalid' | 'capability_denied' | 'cancelled' | 'timeout';

/**
 * T-I1 (type-level): a WHITELIST schema. This type MUST NOT gain `notes`,
 * `hypothesis`, `whatITried`, `summary`, `narrative`, `rationale`, or any other
 * free-text field capable of carrying the failed attempt's own account of
 * itself. Evidence from a DIFFERENT role at a boundary is admissible via
 * `externalFindings`; the attempt's narrative is not, and no channel exists.
 */
export interface FailureRecord {
  readonly klass: FailureClass;
  readonly detectedBy: string;              // gate ref | 'kernel' | 'human'. Never 'self'.
  readonly failedCriteria: readonly string[];
  readonly violatedConstraints: readonly { readonly sourceArtifact: ArtifactId; readonly constraintId: string }[];
  readonly gateResults: readonly { readonly gateRef: VersionedRef; readonly verdict: GateVerdict; readonly location?: string; readonly outputExcerpt?: string }[];
  readonly gateErrors: readonly { readonly gateRef: VersionedRef; readonly errorClass: string; readonly outputExcerpt: string; readonly retryOrdinal: number }[];
  readonly observedVsExpected: readonly { readonly location: string; readonly expected: string; readonly observed: string }[];
  readonly reproduction: readonly { readonly command: string; readonly exitCode: number; readonly outputExcerpt: string }[];
  readonly diffSummary: { readonly filesTouched: number; readonly insertions: number; readonly deletions: number };
  readonly externalFindings: readonly {
    readonly sourceRoleRef: VersionedRef;
    readonly findingId: string;
    readonly claim: string;
    readonly evidence: string;
    readonly location?: string;
    readonly suggestedDirection?: string;
  }[];
  readonly denials: readonly DenialRecord[];
}

// ------------------------------------------------------------------ approval

export interface Approval {
  readonly id: ApprovalId;
  readonly subject: { readonly kind: string; readonly ref: string; readonly contentHash: Hash };
  readonly decision: 'approve' | 'reject' | 'approve_with_conditions';
  readonly quorum: string;                  // "N of M" — C3
  readonly approvers: readonly string[];
  readonly signatures: readonly { readonly approver: string; readonly decidedAt: Timestamp; readonly contentHash: Hash }[];
  readonly blocking: boolean;               // D4 — false for memory commits
  readonly decidedAt: Timestamp | null;
  readonly scope: { readonly reuse: 'one_time' | 'until_timestamp' | 'for_plan'; readonly expiresAt: Timestamp | null };
}

// --------------------------------------------------------------------- lease

export interface Lease {
  readonly workUnitId: WorkUnitId;
  readonly attemptId: AttemptId;
  readonly epoch: number;
  readonly holder: string;
  readonly acquiredAt: Timestamp;
  readonly expiresAt: Timestamp;
}

// --------------------------------------------------------------------- event

export interface EventEnvelope {
  readonly eventId: EventId;
  readonly instanceId: InstanceId;
  readonly type: string;
  readonly occurredAt: Timestamp;           // kernel clock only (Note 06 §13)
  readonly actor: string;
  readonly subject: readonly string[];
  readonly causationId: EventId | null;
  readonly correlationId: string | null;
  readonly payload: Record<string, unknown>;
}

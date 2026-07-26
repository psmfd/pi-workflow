import type { InvocationErrorCode } from "../subagent/contracts.js";

/** Version shared by persisted workflow definitions, state, and journal records. */
export const WORKFLOW_RUNTIME_CONTRACT_VERSION = 1;

export type WorkflowRuntimeContractVersion = typeof WORKFLOW_RUNTIME_CONTRACT_VERSION;
export type WorkflowExecutionClass = "readOnly" | "mutating";
export type WorkflowScopeKind = "localChanges" | "pullRequest";
export type RetryableOutcome = "failed" | "cancelled" | "timedOut";

/** A typed workflow is authored in TypeScript and may be constructed dynamically. */
export interface WorkflowDefinition {
  readonly contractVersion: WorkflowRuntimeContractVersion;
  readonly workflowId: string;
  readonly description?: string;
  readonly steps: readonly WorkflowStepDefinition[];
}

export interface WorkflowStepDefinition {
  readonly stepId: string;
  readonly dependsOn: readonly string[];
  readonly invocation: WorkflowInvocationDefinition;
  readonly retry: WorkflowRetryPolicy;
}

/** Definitions request authority; trusted host policy grants and classifies it before dispatch. */
export interface WorkflowInvocationDefinition {
  readonly agent: string;
  readonly task: string;
  readonly requestedCapabilities: readonly string[];
  readonly timeoutMs?: number;
}

export interface WorkflowInvocationAuthorization {
  readonly capabilities: readonly string[];
  readonly execution: WorkflowExecutionClass;
  readonly policyDigest: string;
}

/** `indeterminate` is deliberately absent: uncertain work always requires a person. */
export interface WorkflowRetryPolicy {
  readonly maxAttempts: number;
  readonly automaticFor: readonly RetryableOutcome[];
}

/** Canonical identity is computed at run creation and never changes during resume. */
export interface WorkflowRunScope {
  readonly kind: WorkflowScopeKind;
  readonly scopeId: string;
  readonly digest: string;
  readonly repositoryRoot: string;
  readonly baseRevision: string;
  readonly headRevision?: string;
  readonly pullRequestNumber?: number;
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate";

export type WorkflowStepStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "indeterminate"
  | "blocked";

/** Durable error classification excludes child-authored messages and other sensitive text. */
export interface WorkflowFailureSummary {
  readonly code: InvocationErrorCode;
  readonly phase: "preflight" | "dispatch" | "execution" | "handoff" | "cleanup";
  readonly retryable: boolean;
}

export type WorkflowAttemptOutcome =
  | {
      readonly invocationId: string;
      readonly attempt: number;
      readonly inputDigest: string;
      readonly status: "succeeded";
    }
  | {
      readonly invocationId: string;
      readonly attempt: number;
      readonly inputDigest: string;
      readonly status: "failed" | "indeterminate";
      readonly error: WorkflowFailureSummary;
    }
  | {
      readonly invocationId: string;
      readonly attempt: number;
      readonly inputDigest: string;
      readonly status: "cancelled" | "timedOut";
      readonly acknowledged: true;
    };

export interface WorkflowAttemptState {
  readonly attempt: number;
  readonly invocationId: string;
  readonly inputDigest: string;
  /** Absolute deadline persisted before dispatch; resume must not recompute it. */
  readonly deadlineAt?: string;
  readonly authorization: WorkflowInvocationAuthorization;
  readonly status: "planned" | "running" | "recoveryRequired" | "settled";
  readonly outcome?: WorkflowAttemptOutcome;
}

export interface WorkflowStepState {
  readonly stepId: string;
  readonly status: WorkflowStepStatus;
  readonly attempts: readonly WorkflowAttemptState[];
  readonly evidence: readonly WorkflowEvidenceReference[];
}

export interface WorkflowRunState {
  readonly contractVersion: WorkflowRuntimeContractVersion;
  readonly runId: string;
  readonly workflowId: string;
  readonly definitionDigest: string;
  readonly scope: WorkflowRunScope;
  readonly status: WorkflowRunStatus;
  /** Definition order is retained to make serialization and presentation stable. */
  readonly steps: readonly WorkflowStepState[];
  readonly lastSequence: number;
}

export interface WorkflowEvidenceReference {
  readonly evidenceId: string;
  readonly stepId: string;
  readonly invocationId: string;
  readonly attempt: number;
  readonly inputDigest: string;
  readonly scopeDigest: string;
  readonly valid: boolean;
  readonly invalidatedBySequence?: number;
}

/** Content is held by a protected artifact store; journal records contain metadata only. */
export interface WorkflowArtifactReference {
  readonly artifactId: string;
  readonly digest: string;
  readonly mediaType: string;
  readonly byteLength: number;
  readonly storage: "protectedExternal";
}

interface WorkflowEventBase {
  readonly eventId: string;
}

export type WorkflowEvent =
  | (WorkflowEventBase & {
      readonly type: "runCreated";
      readonly definition: WorkflowDefinition;
      readonly definitionDigest: string;
      readonly scope: WorkflowRunScope;
    })
  | (WorkflowEventBase & { readonly type: "runStarted" })
  | (WorkflowEventBase & { readonly type: "stepReady"; readonly stepId: string })
  | (WorkflowEventBase & {
      readonly type: "attemptPlanned";
      readonly stepId: string;
      readonly attempt: number;
      readonly invocationId: string;
      readonly inputDigest: string;
      readonly deadlineAt?: string;
      readonly authorization: WorkflowInvocationAuthorization;
    })
  | (WorkflowEventBase & {
      readonly type: "attemptStarted";
      readonly stepId: string;
      readonly attempt: number;
      readonly invocationId: string;
      readonly inputDigest: string;
    })
  | (WorkflowEventBase & {
      readonly type: "attemptSettled";
      readonly stepId: string;
      readonly attempt: number;
      readonly invocationId: string;
      readonly inputDigest: string;
      readonly outcome: WorkflowAttemptOutcome;
    })
  | (WorkflowEventBase & {
      readonly type: "evidenceRecorded";
      readonly evidence: WorkflowEvidenceReference;
      readonly artifact?: WorkflowArtifactReference;
    })
  | (WorkflowEventBase & {
      readonly type: "evidenceInvalidated";
      readonly evidenceId: string;
      readonly reason: "scopeChanged" | "inputChanged" | "superseded" | "manual";
    })
  | (WorkflowEventBase & {
      readonly type: "attemptRecoveryRequired";
      readonly stepId: string;
      readonly attempt: number;
      readonly invocationId: string;
      readonly inputDigest: string;
      readonly execution: WorkflowExecutionClass;
      readonly reason: "hostRestart" | "journalInterrupted" | "terminationUnconfirmed";
    })
  | (WorkflowEventBase & {
      readonly type: "attemptRecoveryResolved";
      readonly stepId: string;
      readonly attempt: number;
      readonly invocationId: string;
      readonly inputDigest: string;
      readonly resolution: "effectConfirmed" | "safeToRetry" | "abort";
    })
  | (WorkflowEventBase & { readonly type: "cancellationRequested"; readonly reason: string })
  | (WorkflowEventBase & {
      readonly type: "runSettled";
      readonly status: Exclude<WorkflowRunStatus, "pending" | "running">;
    });

/** One append-only persisted record. Sequence numbers are contiguous per run. */
export interface WorkflowJournalEnvelope {
  readonly contractVersion: WorkflowRuntimeContractVersion;
  readonly runId: string;
  readonly sequence: number;
  readonly occurredAt: string;
  readonly event: WorkflowEvent;
}

export type WorkflowRecoveryDecision =
  | { readonly action: "replayTerminalOutcome"; readonly invocationId: string; readonly attempt: number }
  | {
      readonly action: "dispatchAttempt";
      readonly invocationId: string;
      readonly attempt: number;
      readonly deadlineAt?: string;
    }
  | {
      readonly action: "recordRecoveryRequired";
      readonly invocationId: string;
      readonly attempt: number;
      readonly execution: WorkflowExecutionClass;
    }
  | {
      readonly action: "awaitManualResolution";
      readonly reason: "indeterminateMutation" | "invalidEvidence" | "unsupportedVersion";
    }
  | { readonly action: "abortRun"; readonly reason: string };

/** Compatibility contract retained until issue #17 supplies the migration wrapper. */
export interface LegacyReviewCompatibility {
  readonly command: "/review";
  readonly ownership: "legacyPromptWorkflow";
  readonly automaticMigration: false;
}

export const LEGACY_REVIEW_COMPATIBILITY: LegacyReviewCompatibility = {
  command: "/review",
  ownership: "legacyPromptWorkflow",
  automaticMigration: false,
};

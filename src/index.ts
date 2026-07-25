import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export {
  LEGACY_REVIEW_COMPATIBILITY,
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  type LegacyReviewCompatibility,
  type RetryableOutcome,
  type WorkflowArtifactReference,
  type WorkflowAttemptOutcome,
  type WorkflowAttemptState,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowEvidenceReference,
  type WorkflowExecutionClass,
  type WorkflowFailureSummary,
  type WorkflowInvocationAuthorization,
  type WorkflowInvocationDefinition,
  type WorkflowJournalEnvelope,
  type WorkflowRecoveryDecision,
  type WorkflowRetryPolicy,
  type WorkflowRunScope,
  type WorkflowRunState,
  type WorkflowRunStatus,
  type WorkflowRuntimeContractVersion,
  type WorkflowScopeKind,
  type WorkflowStepDefinition,
  type WorkflowStepState,
  type WorkflowStepStatus,
} from "./runtime/contracts.js";
export {
  MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES,
  WORKFLOW_DEFINITION_SCHEMA,
  WORKFLOW_JOURNAL_ENVELOPE_SCHEMA,
  isLegalRunTransition,
  isLegalStepTransition,
  parseWorkflowJournalEnvelopeJson,
  validateWorkflowDefinition,
  validateWorkflowJournalEnvelope,
  type ContractSchema,
  type ContractViolation,
  type WorkflowJournalParseResult,
} from "./runtime/validation.js";

export {
  SUBAGENT_INVOCATION_CONTRACT_VERSION,
  type InvocationControl,
  type InvocationError,
  type InvocationErrorCode,
  type InvocationEvidence,
  type InvocationOutcome,
  type InvocationRequest,
  type InvocationUsage,
  type SubagentInvoker,
} from "./subagent/contracts.js";
export {
  PiProcessInvoker,
  type PiCommand,
  type PiProcessInvokerOptions,
} from "./subagent/pi-process-invoker.js";

/** Public contract version for the package entrypoint. */
export const PI_WORKFLOW_API_VERSION = 1;

/** Register the pi-workflow extension. Runtime features are added incrementally. */
export default function registerPiWorkflow(pi: ExtensionAPI): void {
  // The package baseline intentionally registers no commands or tools yet.
  void pi;

  const loadSentinel = process.env["PI_WORKFLOW_LOAD_SENTINEL"];
  if (loadSentinel !== undefined && loadSentinel.length > 0) {
    void process.stdout.write(`${loadSentinel}\n`);
  }
}

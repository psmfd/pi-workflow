import {
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowJournalEnvelope,
  type WorkflowRunScope,
} from "../src/index.js";

export const TEST_DEFINITION: WorkflowDefinition = {
  contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
  workflowId: "test.review",
  steps: [
    {
      stepId: "review",
      dependsOn: [],
      invocation: {
        agent: "code-review-expert",
        task: "Review the canonical scope.",
        requestedCapabilities: ["read"],
        timeoutMs: 60_000,
      },
      retry: { maxAttempts: 2, automaticFor: ["failed", "timedOut"] },
    },
    {
      stepId: "summary",
      dependsOn: ["review"],
      invocation: {
        agent: "docs-expert",
        task: "Summarize the accepted review.",
        requestedCapabilities: ["read"],
      },
      retry: { maxAttempts: 1, automaticFor: [] },
    },
  ],
};

export const TEST_SCOPE: WorkflowRunScope = {
  kind: "localChanges",
  scopeId: "local:test",
  digest: "scope-digest",
  repositoryRoot: "/workspace/repository",
  baseRevision: "base-revision",
};

export function envelope(
  sequence: number,
  event: WorkflowEvent,
  runId = "run-1",
): WorkflowJournalEnvelope {
  return {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId,
    sequence,
    occurredAt: `2026-07-26T00:00:${String(sequence).padStart(2, "0")}Z`,
    actor: { kind: "runtime", actorId: "runtime-test" },
    event,
  };
}

export function creation(sequence = 1, runId = "run-1"): WorkflowJournalEnvelope {
  return envelope(sequence, {
    eventId: `event-${sequence}`,
    type: "runCreated",
    definition: structuredClone(TEST_DEFINITION),
    definitionDigest: "definition-digest",
    scope: structuredClone(TEST_SCOPE),
  }, runId);
}

export function successfulReviewEvents(runId = "run-1"): readonly WorkflowJournalEnvelope[] {
  return [
    creation(1, runId),
    envelope(2, { eventId: "event-2", type: "runStarted" }, runId),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }, runId),
    envelope(4, {
      eventId: "event-4",
      type: "attemptPlanned",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      deadlineAt: "2026-07-26T00:05:00Z",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }, runId),
    envelope(5, {
      eventId: "event-5",
      type: "attemptStarted",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
    }, runId),
    envelope(6, {
      eventId: "event-6",
      type: "attemptSettled",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      outcome: {
        status: "succeeded",
        attempt: 1,
        invocationId: "invocation-1",
        inputDigest: "input-1",
      },
    }, runId),
    envelope(7, {
      eventId: "event-7",
      type: "evidenceRecorded",
      evidence: {
        evidenceId: "evidence-1",
        stepId: "review",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        scopeDigest: "scope-digest",
        valid: true,
      },
    }, runId),
    envelope(8, {
      eventId: "event-8",
      type: "stepSettled",
      stepId: "review",
      settlement: {
        status: "succeeded",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        evidenceIds: ["evidence-1"],
      },
    }, runId),
  ];
}

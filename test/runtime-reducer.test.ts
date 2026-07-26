import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveWorkflowRecoveryDecisions,
  reduceWorkflowJournalEnvelope,
  type WorkflowJournalEnvelope,
  type WorkflowRunState,
} from "../src/index.js";
import { creation, envelope, successfulReviewEvents } from "./runtime-fixtures.js";

function reduceAll(events: readonly WorkflowJournalEnvelope[]): WorkflowRunState {
  let state: WorkflowRunState | undefined;
  for (const candidate of events) {
    const result = reduceWorkflowJournalEnvelope(state, candidate);
    assert.equal(result.ok, true, result.ok ? undefined : result.error.message);
    if (result.ok) state = result.state;
  }
  assert.ok(state);
  return state;
}

void test("reducer applies successful attempt, evidence, and step settlement without mutating inputs", () => {
  const events = successfulReviewEvents();
  const created = events[0];
  assert.ok(created);
  const state = reduceAll(events);

  assert.equal(state.status, "running");
  assert.equal(state.steps[0]?.status, "succeeded");
  assert.deepEqual(state.steps[0]?.settlement, {
    status: "succeeded",
    invocationId: "invocation-1",
    attempt: 1,
    inputDigest: "input-1",
    evidenceIds: ["evidence-1"],
  });
  assert.equal(state.lastSequence, 8);
  assert.equal(state.processedEventIds.length, 8);

  if (created.event.type === "runCreated") {
    (created.event.definition.steps as unknown as { stepId: string }[])[0]!.stepId = "mutated";
  }
  assert.equal(state.definition.steps[0]?.stepId, "review");
});

void test("reducer rejects gaps, duplicate event IDs, cross-run records, and post-terminal events", () => {
  const initial = reduceAll([creation()]);
  assert.equal(reduceWorkflowJournalEnvelope(initial, envelope(3, { eventId: "event-3", type: "runStarted" })).ok, false);
  assert.equal(reduceWorkflowJournalEnvelope(initial, envelope(2, { eventId: "event-1", type: "runStarted" })).ok, false);
  assert.equal(reduceWorkflowJournalEnvelope(initial, envelope(2, { eventId: "event-2", type: "runStarted" }, "other-run")).ok, false);

  const cancelledSteps = [
    creation(),
    envelope(2, { eventId: "event-2", type: "cancellationRequested", reason: "hostShutdown" }),
    envelope(3, { eventId: "event-3", type: "stepSettled", stepId: "review", settlement: { status: "cancelled", reason: "hostShutdown" } }),
    envelope(4, { eventId: "event-4", type: "stepSettled", stepId: "summary", settlement: { status: "cancelled", reason: "hostShutdown" } }),
    envelope(5, { eventId: "event-5", type: "runSettled", status: "cancelled" }),
  ] as const;
  const terminal = reduceAll(cancelledSteps);
  assert.equal(terminal.status, "cancelled");
  const after = reduceWorkflowJournalEnvelope(terminal, envelope(6, { eventId: "event-6", type: "runStarted" }));
  assert.equal(after.ok, false);
  if (!after.ok) assert.equal(after.error.code, "terminalRun");
});

void test("attempt settlement remains nonterminal until retry or explicit step settlement", () => {
  const events = [
    creation(),
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4",
      type: "attemptPlanned",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }),
    envelope(5, { eventId: "event-5", type: "attemptStarted", stepId: "review", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1" }),
    envelope(6, {
      eventId: "event-6",
      type: "attemptSettled",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      outcome: {
        status: "failed",
        attempt: 1,
        invocationId: "invocation-1",
        inputDigest: "input-1",
        error: { code: "agentFailed", phase: "execution", retryable: true },
      },
    }),
  ] as const;
  const failedAttempt = reduceAll(events);
  assert.equal(failedAttempt.steps[0]?.status, "running");

  const retried = reduceWorkflowJournalEnvelope(failedAttempt, envelope(7, { eventId: "event-7", type: "stepReady", stepId: "review" }));
  assert.equal(retried.ok, true);
  if (retried.ok) assert.equal(retried.state.steps[0]?.status, "ready");

  const terminalized = reduceWorkflowJournalEnvelope(failedAttempt, envelope(7, {
    eventId: "event-terminal",
    type: "stepSettled",
    stepId: "review",
    settlement: {
      status: "failed",
      invocationId: "invocation-1",
      attempt: 1,
      inputDigest: "input-1",
      reason: "retryDeclined",
    },
  }));
  assert.equal(terminalized.ok, true);
  if (terminalized.ok) assert.equal(terminalized.state.steps[0]?.status, "failed");
});

void test("non-automatic retries require operator authority and nonretryable failures stay terminal", () => {
  const common = [
    creation(),
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4", type: "attemptPlanned", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }),
    envelope(5, { eventId: "event-5", type: "attemptStarted", stepId: "review", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1" }),
  ] as const;
  const cancelled = reduceAll([...common, envelope(6, {
    eventId: "event-6", type: "attemptSettled", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
    outcome: { status: "cancelled", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1", acknowledged: true },
  })]);
  const runtimeRetry = reduceWorkflowJournalEnvelope(cancelled, envelope(7, {
    eventId: "event-runtime", type: "stepReady", stepId: "review",
  }));
  assert.equal(runtimeRetry.ok, false);
  const operatorRetryEnvelope = envelope(7, { eventId: "event-operator", type: "stepReady", stepId: "review" });
  const operatorRetry = reduceWorkflowJournalEnvelope(cancelled, {
    ...operatorRetryEnvelope,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(operatorRetry.ok, true);

  const nonretryable = reduceAll([...common, envelope(6, {
    eventId: "event-nonretryable", type: "attemptSettled", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
    outcome: {
      status: "failed", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1",
      error: { code: "agentFailed", phase: "execution", retryable: false },
    },
  })]);
  const operatorOverride = reduceWorkflowJournalEnvelope(nonretryable, {
    ...operatorRetryEnvelope,
    event: { ...operatorRetryEnvelope.event, eventId: "event-forbidden" },
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(operatorOverride.ok, false);
});

void test("planned attempts may settle pre-dispatch but cannot start after cancellation", () => {
  const planned = reduceAll([
    creation(),
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4", type: "attemptPlanned", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }),
  ]);
  const cancelled = reduceWorkflowJournalEnvelope(planned, envelope(5, {
    eventId: "event-5", type: "cancellationRequested", reason: "hostShutdown",
  }));
  assert.equal(cancelled.ok, true);
  if (!cancelled.ok) return;
  assert.deepEqual(deriveWorkflowRecoveryDecisions(cancelled.state), [{
    action: "recordAttemptCancellation",
    stepId: "review",
    invocationId: "invocation-1",
    attempt: 1,
    inputDigest: "input-1",
  }, {
    action: "recordStepSettlement",
    stepId: "summary",
    settlement: { status: "cancelled", reason: "hostShutdown" },
  }]);
  const lateStart = reduceWorkflowJournalEnvelope(cancelled.state, envelope(6, {
    eventId: "event-6", type: "attemptStarted", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
  }));
  assert.equal(lateStart.ok, false);
  const settled = reduceWorkflowJournalEnvelope(cancelled.state, envelope(6, {
    eventId: "event-6-settled", type: "attemptSettled", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
    outcome: { status: "cancelled", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1", acknowledged: true },
  }));
  assert.equal(settled.ok, true);
});

void test("successful settlement requires currently valid evidence fenced to the attempt and scope", () => {
  const beforeEvidence = reduceAll(successfulReviewEvents().slice(0, 6));
  const missing = reduceWorkflowJournalEnvelope(beforeEvidence, envelope(7, {
    eventId: "event-7",
    type: "stepSettled",
    stepId: "review",
    settlement: {
      status: "succeeded",
      invocationId: "invocation-1",
      attempt: 1,
      inputDigest: "input-1",
      evidenceIds: ["missing"],
    },
  }));
  assert.equal(missing.ok, false);

  const withEvidence = reduceAll(successfulReviewEvents().slice(0, 7));
  const invalidated = reduceWorkflowJournalEnvelope(withEvidence, envelope(8, {
    eventId: "event-8",
    type: "evidenceInvalidated",
    evidenceId: "evidence-1",
    reason: "manual",
  }));
  assert.equal(invalidated.ok, true);
  if (invalidated.ok) {
    const settlement = reduceWorkflowJournalEnvelope(invalidated.state, envelope(9, {
      eventId: "event-9",
      type: "stepSettled",
      stepId: "review",
      settlement: {
        status: "succeeded",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        evidenceIds: ["evidence-1"],
      },
    }));
    assert.equal(settlement.ok, false);
  }
});

void test("blocking and aggregate settlement are explicit and deterministic", () => {
  const prefix = [
    creation(),
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4", type: "attemptPlanned", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }),
    envelope(5, { eventId: "event-5", type: "attemptStarted", stepId: "review", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1" }),
    envelope(6, {
      eventId: "event-6", type: "attemptSettled", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1",
      outcome: {
        status: "failed", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1",
        error: { code: "agentFailed", phase: "execution", retryable: false },
      },
    }),
    envelope(7, {
      eventId: "event-7", type: "stepSettled", stepId: "review",
      settlement: { status: "failed", invocationId: "invocation-1", attempt: 1, inputDigest: "input-1", reason: "attemptOutcome" },
    }),
    envelope(8, { eventId: "event-8", type: "stepSettled", stepId: "summary", settlement: { status: "blocked", blockedBy: "review" } }),
  ] as const;
  const state = reduceAll(prefix);
  const wrong = reduceWorkflowJournalEnvelope(state, envelope(9, { eventId: "event-wrong", type: "runSettled", status: "succeeded" }));
  assert.equal(wrong.ok, false);
  const settled = reduceWorkflowJournalEnvelope(state, envelope(9, { eventId: "event-9", type: "runSettled", status: "failed" }));
  assert.equal(settled.ok, true);
});

void test("safe recovery resolution is rejected when the attempt budget is exhausted", () => {
  const created = creation();
  if (created.event.type !== "runCreated") throw new Error("fixture must create a run");
  const oneAttemptCreation: WorkflowJournalEnvelope = {
    ...created,
    event: {
      ...created.event,
      definition: {
        ...created.event.definition,
        steps: created.event.definition.steps.map((step) => step.stepId === "review"
          ? { ...step, retry: { ...step.retry, maxAttempts: 1 } }
          : step),
      },
    },
  };
  const required = reduceAll([
    oneAttemptCreation,
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4", type: "attemptPlanned", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1",
      authorization: { capabilities: ["read"], execution: "readOnly", policyDigest: "policy-1" },
    }),
    envelope(5, { eventId: "event-5", type: "attemptStarted", stepId: "review", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1" }),
    envelope(6, {
      eventId: "event-6", type: "attemptRecoveryRequired", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1", execution: "readOnly", reason: "hostRestart",
    }),
  ]);
  const resolution = envelope(7, {
    eventId: "event-7", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1", resolution: { kind: "safeToRetry" },
  });
  const result = reduceWorkflowJournalEnvelope(required, {
    ...resolution,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(result.ok, false);
});

void test("recovery decisions preserve invocation identity and require manual resolution for interrupted mutation", () => {
  const planned = reduceAll([
    creation(),
    envelope(2, { eventId: "event-2", type: "runStarted" }),
    envelope(3, { eventId: "event-3", type: "stepReady", stepId: "review" }),
    envelope(4, {
      eventId: "event-4", type: "attemptPlanned", stepId: "review", attempt: 1,
      invocationId: "invocation-1", inputDigest: "input-1", deadlineAt: "2026-07-26T00:05:00Z",
      authorization: { capabilities: ["read"], execution: "mutating", policyDigest: "policy-1" },
    }),
  ]);
  assert.deepEqual(deriveWorkflowRecoveryDecisions(planned), [{
    action: "dispatchAttempt", stepId: "review", invocationId: "invocation-1", attempt: 1,
    deadlineAt: "2026-07-26T00:05:00Z",
  }]);

  const started = reduceWorkflowJournalEnvelope(planned, envelope(5, {
    eventId: "event-5", type: "attemptStarted", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
  }));
  assert.equal(started.ok, true);
  if (!started.ok) return;
  assert.equal(deriveWorkflowRecoveryDecisions(started.state)[0]?.action, "recordRecoveryRequired");

  const required = reduceWorkflowJournalEnvelope(started.state, envelope(6, {
    eventId: "event-6", type: "attemptRecoveryRequired", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1", execution: "mutating", reason: "hostRestart",
  }));
  assert.equal(required.ok, true);
  if (!required.ok) return;
  assert.deepEqual(deriveWorkflowRecoveryDecisions(required.state), [{
    action: "awaitManualResolution", stepId: "review", invocationId: "invocation-1", attempt: 1,
    reason: "indeterminateMutation",
  }]);
  const unsafeRetry = reduceWorkflowJournalEnvelope(required.state, envelope(7, {
    eventId: "event-unsafe", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1", resolution: { kind: "safeToRetry" },
  }));
  assert.equal(unsafeRetry.ok, false);

  const safeEnvelope = envelope(7, {
    eventId: "event-safe", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1", resolution: { kind: "safeToRetry" },
  });
  const safe = reduceWorkflowJournalEnvelope(required.state, {
    ...safeEnvelope,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(safe.ok, true);
  if (safe.ok) assert.deepEqual(deriveWorkflowRecoveryDecisions(safe.state), [
    { action: "recordStepReady", stepId: "review" },
  ]);

  const abortEnvelope = envelope(7, {
    eventId: "event-abort", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1", resolution: { kind: "abort" },
  });
  const aborted = reduceWorkflowJournalEnvelope(required.state, {
    ...abortEnvelope,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(aborted.ok, true);
  const abortedDecision = [{
    action: "recordStepSettlement" as const,
    stepId: "review",
    settlement: {
      status: "indeterminate" as const,
      invocationId: "invocation-1",
      attempt: 1,
      inputDigest: "input-1",
      reason: "recoveryAborted" as const,
    },
  }];
  if (aborted.ok) {
    assert.deepEqual(deriveWorkflowRecoveryDecisions(aborted.state), abortedDecision);
    const wrongAbortReason = reduceWorkflowJournalEnvelope(aborted.state, envelope(8, {
      eventId: "event-wrong-abort-reason",
      type: "stepSettled",
      stepId: "review",
      settlement: {
        status: "indeterminate",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        reason: "attemptOutcome",
      },
    }));
    assert.equal(wrongAbortReason.ok, false);
    const cancelledAfterAbort = reduceWorkflowJournalEnvelope(aborted.state, envelope(8, {
      eventId: "event-cancel-after-abort",
      type: "cancellationRequested",
      reason: "hostShutdown",
    }));
    assert.equal(cancelledAfterAbort.ok, true);
    if (cancelledAfterAbort.ok) {
      assert.deepEqual(deriveWorkflowRecoveryDecisions(cancelledAfterAbort.state)[0], abortedDecision[0]);
    }
  }

  const indeterminateEnvelope = envelope(7, {
    eventId: "event-indeterminate", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
    resolution: {
      kind: "outcomeConfirmed",
      outcome: {
        status: "indeterminate",
        attempt: 1,
        invocationId: "invocation-1",
        inputDigest: "input-1",
        error: { code: "executionUncertain", phase: "execution", retryable: false },
      },
    },
  });
  const indeterminate = reduceWorkflowJournalEnvelope(required.state, {
    ...indeterminateEnvelope,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(indeterminate.ok, true);
  if (indeterminate.ok) {
    const wrongOutcomeReason = reduceWorkflowJournalEnvelope(indeterminate.state, envelope(8, {
      eventId: "event-wrong-outcome-reason",
      type: "stepSettled",
      stepId: "review",
      settlement: {
        status: "indeterminate",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        reason: "recoveryAborted",
      },
    }));
    assert.equal(wrongOutcomeReason.ok, false);
  }

  const resolution = envelope(7, {
    eventId: "event-7", type: "attemptRecoveryResolved", stepId: "review", attempt: 1,
    invocationId: "invocation-1", inputDigest: "input-1",
    resolution: {
      kind: "outcomeConfirmed",
      outcome: { status: "succeeded", attempt: 1, invocationId: "invocation-1", inputDigest: "input-1" },
    },
  });
  const resolved = reduceWorkflowJournalEnvelope(required.state, {
    ...resolution,
    actor: { kind: "operator", actorId: "operator-test" },
  });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(deriveWorkflowRecoveryDecisions(resolved.state)[0]?.action, "replayTerminalOutcome");
});

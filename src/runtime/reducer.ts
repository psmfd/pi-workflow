/* eslint-disable security/detect-object-injection -- indexes are obtained from bounded package-owned step arrays */
import {
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  type WorkflowAttemptOutcome,
  type WorkflowAttemptState,
  type WorkflowEvent,
  type WorkflowJournalEnvelope,
  type WorkflowRecoveryDecision,
  type WorkflowRunState,
  type WorkflowStepDefinition,
  type WorkflowStepSettlement,
  type WorkflowStepState,
} from "./contracts.js";
import { validateWorkflowJournalEnvelope } from "./validation.js";

export type WorkflowReductionErrorCode =
  | "invalidEnvelope"
  | "invalidFirstEvent"
  | "runMismatch"
  | "sequenceMismatch"
  | "duplicateEvent"
  | "terminalRun"
  | "illegalTransition"
  | "unknownStep"
  | "attemptMismatch"
  | "duplicateInvocation"
  | "duplicateEvidence"
  | "evidenceMismatch"
  | "aggregateMismatch";

export interface WorkflowReductionError {
  readonly code: WorkflowReductionErrorCode;
  readonly message: string;
}

export type WorkflowReductionResult =
  | { readonly ok: true; readonly state: WorkflowRunState }
  | { readonly ok: false; readonly error: WorkflowReductionError };

/** Internal replay accelerator; it is not persisted or part of the package API. */
export interface WorkflowReductionContext {
  readonly eventIds: Set<string>;
}

export function createWorkflowReductionContext(): WorkflowReductionContext {
  return { eventIds: new Set<string>() };
}

export function materializeWorkflowEventIds(
  state: WorkflowRunState,
  context: WorkflowReductionContext,
): WorkflowRunState {
  return { ...state, processedEventIds: [...context.eventIds] };
}

function failure(code: WorkflowReductionErrorCode, message: string): WorkflowReductionResult {
  return { ok: false, error: { code, message } };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function stepDefinition(state: WorkflowRunState, stepId: string): WorkflowStepDefinition | undefined {
  return state.definition.steps.find((candidate) => candidate.stepId === stepId);
}

function stepIndex(state: WorkflowRunState, stepId: string): number {
  return state.steps.findIndex((candidate) => candidate.stepId === stepId);
}

function replaceStep(
  state: WorkflowRunState,
  index: number,
  replacement: WorkflowStepState,
): WorkflowRunState {
  return {
    ...state,
    steps: state.steps.map((step, candidateIndex) => candidateIndex === index ? replacement : step),
  };
}

function finishEnvelope(
  state: WorkflowRunState,
  envelope: WorkflowJournalEnvelope,
  context?: WorkflowReductionContext,
): WorkflowRunState {
  context?.eventIds.add(envelope.event.eventId);
  return {
    ...state,
    processedEventIds: context === undefined
      ? [...state.processedEventIds, envelope.event.eventId]
      : state.processedEventIds,
    lastSequence: envelope.sequence,
  };
}

function sameAttempt(
  attempt: WorkflowAttemptState,
  identity: { readonly attempt: number; readonly invocationId: string; readonly inputDigest: string },
): boolean {
  return attempt.attempt === identity.attempt &&
    attempt.invocationId === identity.invocationId &&
    attempt.inputDigest === identity.inputDigest;
}

function latestAttempt(step: WorkflowStepState): WorkflowAttemptState | undefined {
  return step.attempts.at(-1);
}

function hasActiveAttempt(step: WorkflowStepState): boolean {
  return step.attempts.some((attempt) =>
    attempt.status === "planned" || attempt.status === "running" || attempt.status === "recoveryRequired"
  );
}

function outcomeSupportsRetry(
  outcome: WorkflowAttemptOutcome | undefined,
): outcome is WorkflowAttemptOutcome & { readonly status: "failed" | "cancelled" | "timedOut" } {
  return outcome?.status === "failed" || outcome?.status === "cancelled" || outcome?.status === "timedOut";
}

function canBecomeReady(
  state: WorkflowRunState,
  step: WorkflowStepState,
  actorKind: "runtime" | "operator",
): boolean {
  const definition = stepDefinition(state, step.stepId);
  if (definition === undefined) return false;
  if (step.status === "pending") {
    return definition.dependsOn.every((dependency) =>
      state.steps.find((candidate) => candidate.stepId === dependency)?.status === "succeeded"
    );
  }
  if (step.status !== "running" || hasActiveAttempt(step)) return false;
  const latest = latestAttempt(step);
  if (latest === undefined || latest.attempt >= definition.retry.maxAttempts) return false;
  if (latest.recoveryResolution?.kind === "safeToRetry") return true;
  const outcome = latest.outcome;
  if (!outcomeSupportsRetry(outcome)) return false;
  if (outcome.status === "failed" && !outcome.error.retryable) return false;
  if (definition.retry.automaticFor.includes(outcome.status)) return true;
  return actorKind === "operator";
}

function findAttemptForSettlement(
  step: WorkflowStepState,
  settlement: Extract<WorkflowStepSettlement, { readonly invocationId: string }>,
): WorkflowAttemptState | undefined {
  const latest = latestAttempt(step);
  return latest !== undefined && sameAttempt(latest, settlement) ? latest : undefined;
}

function validateSucceededSettlement(
  state: WorkflowRunState,
  step: WorkflowStepState,
  settlement: Extract<WorkflowStepSettlement, { readonly status: "succeeded" }>,
): WorkflowReductionResult | undefined {
  if (state.cancellation !== undefined) {
    return failure("illegalTransition", "a cancelled run cannot settle a step successfully");
  }
  const attempt = findAttemptForSettlement(step, settlement);
  if (attempt?.status !== "settled" || attempt.outcome?.status !== "succeeded") {
    return failure("attemptMismatch", "successful step settlement requires a matching successful attempt");
  }
  for (const evidenceId of settlement.evidenceIds) {
    const evidence = step.evidence.find((candidate) => candidate.evidenceId === evidenceId);
    if (
      evidence === undefined || !evidence.valid || evidence.stepId !== step.stepId ||
      evidence.invocationId !== settlement.invocationId || evidence.attempt !== settlement.attempt ||
      evidence.inputDigest !== settlement.inputDigest || evidence.scopeDigest !== state.scope.digest
    ) {
      return failure("evidenceMismatch", "successful step settlement requires matching valid evidence");
    }
  }
  return undefined;
}

function validateUnsuccessfulSettlement(
  step: WorkflowStepState,
  settlement: Extract<WorkflowStepSettlement, { readonly status: "failed" | "indeterminate" }>,
): WorkflowReductionResult | undefined {
  const attempt = findAttemptForSettlement(step, settlement);
  if (attempt?.status !== "settled") {
    return failure("attemptMismatch", "step settlement requires a matching settled attempt");
  }
  if (settlement.status === "failed") {
    if (!outcomeSupportsRetry(attempt.outcome)) {
      return failure("illegalTransition", "failed step settlement requires an unsuccessful attempt");
    }
    return undefined;
  }
  if (
    (settlement.reason === "attemptOutcome" && attempt.outcome?.status !== "indeterminate") ||
    (settlement.reason === "recoveryAborted" && attempt.recoveryResolution?.kind !== "abort")
  ) {
    return failure("illegalTransition", "indeterminate settlement reason must match its durable cause");
  }
  return undefined;
}

function applyStepSettlement(
  state: WorkflowRunState,
  event: Extract<WorkflowEvent, { readonly type: "stepSettled" }>,
): WorkflowReductionResult | WorkflowRunState {
  const index = stepIndex(state, event.stepId);
  if (index < 0) return failure("unknownStep", "step settlement references an unknown step");
  const step = state.steps[index];
  if (step === undefined || step.settlement !== undefined || hasActiveAttempt(step)) {
    return failure("illegalTransition", "step cannot be settled from its current state");
  }
  const settlement = event.settlement;
  if (settlement.status === "blocked") {
    const definition = stepDefinition(state, step.stepId);
    const dependency = state.steps.find((candidate) => candidate.stepId === settlement.blockedBy);
    if (
      definition === undefined || !definition.dependsOn.includes(settlement.blockedBy) || dependency === undefined ||
      !["failed", "cancelled", "indeterminate", "blocked"].includes(dependency.status) || step.status !== "pending"
    ) {
      return failure("illegalTransition", "blocked settlement requires a terminal unsuccessful dependency");
    }
  } else if (settlement.status === "cancelled") {
    if (state.cancellation?.reason !== settlement.reason || !["pending", "ready", "running"].includes(step.status)) {
      return failure("illegalTransition", "cancelled settlement requires matching cancellation intent");
    }
  } else {
    if (step.status !== "running") {
      return failure("illegalTransition", "attempt-based settlement requires a running step");
    }
    const invalid = settlement.status === "succeeded"
      ? validateSucceededSettlement(state, step, settlement)
      : validateUnsuccessfulSettlement(step, settlement);
    if (invalid !== undefined) return invalid;
  }
  return replaceStep(state, index, { ...step, status: settlement.status, settlement: clone(settlement) });
}

function expectedRunStatus(state: WorkflowRunState): "succeeded" | "failed" | "cancelled" | "indeterminate" | undefined {
  if (state.steps.some((step) => !["succeeded", "failed", "cancelled", "indeterminate", "blocked"].includes(step.status))) {
    return undefined;
  }
  if (state.steps.some((step) => step.status === "indeterminate")) return "indeterminate";
  if (state.steps.some((step) => step.status === "failed" || step.status === "blocked")) return "failed";
  if (state.steps.every((step) => step.status === "succeeded")) return "succeeded";
  return "cancelled";
}

function createRun(
  envelope: WorkflowJournalEnvelope,
  context?: WorkflowReductionContext,
): WorkflowReductionResult {
  if (envelope.sequence !== 1 || envelope.event.type !== "runCreated") {
    return failure("invalidFirstEvent", "sequence one must create the run");
  }
  const event = envelope.event;
  context?.eventIds.add(event.eventId);
  return {
    ok: true,
    state: {
      contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
      runId: envelope.runId,
      workflowId: event.definition.workflowId,
      definitionDigest: event.definitionDigest,
      definition: clone(event.definition),
      scope: clone(event.scope),
      status: "pending",
      steps: event.definition.steps.map((step) => ({
        stepId: step.stepId,
        status: "pending",
        attempts: [],
        evidence: [],
      })),
      processedEventIds: context === undefined ? [event.eventId] : [],
      lastSequence: 1,
    },
  };
}

/** Apply one validated journal envelope without mutating previous state or input. */
export function reduceWorkflowJournalEnvelopeWithContext(
  previous: WorkflowRunState | undefined,
  envelope: WorkflowJournalEnvelope,
  context?: WorkflowReductionContext,
): WorkflowReductionResult {
  if (validateWorkflowJournalEnvelope(envelope).length > 0) {
    return failure("invalidEnvelope", "journal envelope does not satisfy the contract schema");
  }
  if (previous === undefined) return createRun(envelope, context);
  if (previous.runId !== envelope.runId || previous.contractVersion !== envelope.contractVersion) {
    return failure("runMismatch", "journal envelope does not belong to this run");
  }
  if (envelope.sequence !== previous.lastSequence + 1) {
    return failure("sequenceMismatch", "journal sequence must be contiguous");
  }
  if (
    context === undefined
      ? previous.processedEventIds.includes(envelope.event.eventId)
      : context.eventIds.has(envelope.event.eventId)
  ) {
    return failure("duplicateEvent", "journal event identifier must be unique");
  }
  if (["succeeded", "failed", "cancelled", "indeterminate"].includes(previous.status)) {
    return failure("terminalRun", "terminal runs reject further events");
  }

  const event = envelope.event;
  let next: WorkflowRunState = previous;
  switch (event.type) {
    case "runCreated":
      return failure("illegalTransition", "a run can only be created once");
    case "runStarted":
      if (previous.status !== "pending" || previous.cancellation !== undefined) {
        return failure("illegalTransition", "run can only start once before cancellation");
      }
      next = { ...previous, status: "running" };
      break;
    case "stepReady": {
      if (previous.status !== "running" || previous.cancellation !== undefined) {
        return failure("illegalTransition", "step readiness requires an active uncancelled run");
      }
      const index = stepIndex(previous, event.stepId);
      const step = previous.steps[index];
      if (index < 0 || step === undefined) return failure("unknownStep", "step readiness references an unknown step");
      if (!canBecomeReady(previous, step, envelope.actor.kind)) {
        return failure("illegalTransition", "step dependencies, retry policy, or actor authority are not ready");
      }
      next = replaceStep(previous, index, { ...step, status: "ready" });
      break;
    }
    case "attemptPlanned": {
      if (previous.status !== "running" || previous.cancellation !== undefined) {
        return failure("illegalTransition", "attempt planning requires an active uncancelled run");
      }
      const index = stepIndex(previous, event.stepId);
      const step = previous.steps[index];
      const definition = stepDefinition(previous, event.stepId);
      if (index < 0 || step === undefined || definition === undefined) return failure("unknownStep", "attempt references an unknown step");
      if (step.status !== "ready" || event.attempt !== step.attempts.length + 1 || event.attempt > definition.retry.maxAttempts) {
        return failure("attemptMismatch", "attempt number or step state is not eligible for planning");
      }
      if (previous.steps.some((candidate) => candidate.attempts.some((attempt) => attempt.invocationId === event.invocationId))) {
        return failure("duplicateInvocation", "invocation identifier must be unique within the run");
      }
      if (event.authorization.capabilities.some((capability) => !definition.invocation.requestedCapabilities.includes(capability))) {
        return failure("illegalTransition", "authorization cannot grant an unrequested capability");
      }
      const attempt: WorkflowAttemptState = {
        attempt: event.attempt,
        invocationId: event.invocationId,
        inputDigest: event.inputDigest,
        ...(event.deadlineAt === undefined ? {} : { deadlineAt: event.deadlineAt }),
        authorization: clone(event.authorization),
        status: "planned",
      };
      next = replaceStep(previous, index, { ...step, status: "running", attempts: [...step.attempts, attempt] });
      break;
    }
    case "attemptStarted":
    case "attemptSettled":
    case "attemptRecoveryRequired":
    case "attemptRecoveryResolved": {
      const index = stepIndex(previous, event.stepId);
      const step = previous.steps[index];
      const attempt = step === undefined ? undefined : latestAttempt(step);
      if (index < 0 || step === undefined) return failure("unknownStep", "attempt event references an unknown step");
      if (attempt === undefined || !sameAttempt(attempt, event)) return failure("attemptMismatch", "attempt event does not match the latest attempt");
      let replacement: WorkflowAttemptState;
      if (event.type === "attemptStarted") {
        if (attempt.status !== "planned" || previous.cancellation !== undefined) {
          return failure("illegalTransition", "only a planned attempt in an uncancelled run can start");
        }
        replacement = { ...attempt, status: "running" };
      } else if (event.type === "attemptSettled") {
        const preDispatchOutcome = event.outcome.status === "cancelled" || event.outcome.status === "timedOut" ||
          (event.outcome.status === "failed" && event.outcome.error.phase === "preflight");
        if (attempt.status !== "running" && !(attempt.status === "planned" && preDispatchOutcome)) {
          return failure("illegalTransition", "attempt outcome is not legal from its current dispatch state");
        }
        replacement = { ...attempt, status: "settled", outcome: clone(event.outcome) };
      } else if (event.type === "attemptRecoveryRequired") {
        if (attempt.status !== "running" || event.execution !== attempt.authorization.execution) {
          return failure("illegalTransition", "recovery must match a running attempt and its execution class");
        }
        replacement = { ...attempt, status: "recoveryRequired" };
      } else {
        if (attempt.status !== "recoveryRequired") return failure("illegalTransition", "only recovery-required attempts can be resolved");
        const definition = stepDefinition(previous, step.stepId);
        if (
          event.resolution.kind === "safeToRetry" &&
          (definition === undefined || attempt.attempt >= definition.retry.maxAttempts)
        ) {
          return failure("illegalTransition", "safe retry requires remaining attempt budget");
        }
        if (
          envelope.actor.kind !== "operator" &&
          (event.resolution.kind !== "safeToRetry" || attempt.authorization.execution === "mutating")
        ) {
          return failure("illegalTransition", "this recovery resolution requires an operator actor");
        }
        replacement = {
          ...attempt,
          status: "settled",
          recoveryResolution: clone(event.resolution),
          ...(event.resolution.kind === "outcomeConfirmed" ? { outcome: clone(event.resolution.outcome) } : {}),
        };
      }
      next = replaceStep(previous, index, {
        ...step,
        attempts: step.attempts.map((candidate, candidateIndex) =>
          candidateIndex === step.attempts.length - 1 ? replacement : candidate
        ),
      });
      break;
    }
    case "evidenceRecorded": {
      if (previous.status !== "running" || previous.cancellation !== undefined) {
        return failure("illegalTransition", "evidence requires an active uncancelled run");
      }
      if (previous.steps.some((step) => step.evidence.some((evidence) => evidence.evidenceId === event.evidence.evidenceId))) {
        return failure("duplicateEvidence", "evidence identifier must be unique within the run");
      }
      const index = stepIndex(previous, event.evidence.stepId);
      const step = previous.steps[index];
      if (index < 0 || step === undefined || step.settlement !== undefined) return failure("unknownStep", "evidence references an unavailable step");
      const attempt = step.attempts.find((candidate) => sameAttempt(candidate, event.evidence));
      if (attempt?.status !== "settled" || attempt.outcome?.status !== "succeeded" || event.evidence.scopeDigest !== previous.scope.digest) {
        return failure("evidenceMismatch", "evidence must match a successful attempt and canonical scope");
      }
      next = replaceStep(previous, index, { ...step, evidence: [...step.evidence, clone(event.evidence)] });
      break;
    }
    case "evidenceInvalidated": {
      let found = false;
      const steps = previous.steps.map((step) => {
        const evidenceIndex = step.evidence.findIndex((evidence) => evidence.evidenceId === event.evidenceId);
        if (evidenceIndex < 0) return step;
        const evidence = step.evidence[evidenceIndex];
        if (evidence === undefined || !evidence.valid || step.settlement !== undefined) return step;
        found = true;
        return {
          ...step,
          evidence: step.evidence.map((candidate, index) => index === evidenceIndex
            ? { ...candidate, valid: false, invalidatedBySequence: envelope.sequence }
            : candidate),
        };
      });
      if (!found) return failure("evidenceMismatch", "only existing valid unsettled evidence can be invalidated");
      next = { ...previous, steps };
      break;
    }
    case "stepSettled": {
      const applied = applyStepSettlement(previous, event);
      if ("ok" in applied) return applied;
      next = applied;
      break;
    }
    case "cancellationRequested":
      if (previous.cancellation !== undefined) return failure("illegalTransition", "cancellation can only be requested once");
      if (
        (event.reason === "operatorRequested" && envelope.actor.kind !== "operator") ||
        (event.reason === "hostShutdown" && envelope.actor.kind !== "runtime")
      ) {
        return failure("illegalTransition", "cancellation reason does not match actor authority");
      }
      next = {
        ...previous,
        cancellation: {
          reason: event.reason,
          requestedAtSequence: envelope.sequence,
          actor: clone(envelope.actor),
        },
      };
      break;
    case "runSettled": {
      const expected = expectedRunStatus(previous);
      if (expected === undefined || expected !== event.status || hasAnyActiveAttempt(previous)) {
        return failure("aggregateMismatch", "run settlement must match fully terminal quiescent steps");
      }
      next = { ...previous, status: event.status };
      break;
    }
  }
  return { ok: true, state: finishEnvelope(next, envelope, context) };
}

/** Apply one envelope directly; replay callers use an internal linear-time identity context. */
export function reduceWorkflowJournalEnvelope(
  previous: WorkflowRunState | undefined,
  envelope: WorkflowJournalEnvelope,
): WorkflowReductionResult {
  return reduceWorkflowJournalEnvelopeWithContext(previous, envelope);
}

function hasAnyActiveAttempt(state: WorkflowRunState): boolean {
  return state.steps.some(hasActiveAttempt);
}

/** Derive deterministic resume actions in definition order without consulting session state. */
export function deriveWorkflowRecoveryDecisions(state: WorkflowRunState): readonly WorkflowRecoveryDecision[] {
  if (["succeeded", "failed", "cancelled", "indeterminate"].includes(state.status)) return [];
  const decisions: WorkflowRecoveryDecision[] = [];
  for (const step of state.steps) {
    if (["succeeded", "failed", "cancelled", "indeterminate", "blocked"].includes(step.status)) continue;
    const attempt = latestAttempt(step);
    if (
      attempt?.status === "settled" &&
      (attempt.recoveryResolution?.kind === "abort" || attempt.outcome?.status === "indeterminate")
    ) {
      decisions.push({
        action: "recordStepSettlement",
        stepId: step.stepId,
        settlement: {
          status: "indeterminate",
          invocationId: attempt.invocationId,
          attempt: attempt.attempt,
          inputDigest: attempt.inputDigest,
          reason: attempt.recoveryResolution?.kind === "abort" ? "recoveryAborted" : "attemptOutcome",
        },
      });
      continue;
    }
    if (state.cancellation !== undefined) {
      if (attempt?.status === "planned") {
        decisions.push({
          action: "recordAttemptCancellation",
          stepId: step.stepId,
          invocationId: attempt.invocationId,
          attempt: attempt.attempt,
          inputDigest: attempt.inputDigest,
        });
        continue;
      }
      if (attempt === undefined || attempt.status === "settled") {
        decisions.push({
          action: "recordStepSettlement",
          stepId: step.stepId,
          settlement: { status: "cancelled", reason: state.cancellation.reason },
        });
        continue;
      }
    }
    if (attempt === undefined) continue;
    if (attempt.status === "planned") {
      decisions.push({
        action: "dispatchAttempt",
        stepId: step.stepId,
        invocationId: attempt.invocationId,
        attempt: attempt.attempt,
        ...(attempt.deadlineAt === undefined ? {} : { deadlineAt: attempt.deadlineAt }),
      });
    } else if (attempt.status === "running") {
      decisions.push({
        action: "recordRecoveryRequired",
        stepId: step.stepId,
        invocationId: attempt.invocationId,
        attempt: attempt.attempt,
        execution: attempt.authorization.execution,
      });
    } else if (attempt.status === "recoveryRequired") {
      decisions.push({
        action: "awaitManualResolution",
        stepId: step.stepId,
        invocationId: attempt.invocationId,
        attempt: attempt.attempt,
        reason: attempt.authorization.execution === "mutating" ? "indeterminateMutation" : "recoveryRequired",
      });
    } else if (attempt.recoveryResolution?.kind === "safeToRetry") {
      decisions.push({ action: "recordStepReady", stepId: step.stepId });
    } else if (attempt.outcome !== undefined && step.settlement === undefined) {
      decisions.push({
        action: "replayTerminalOutcome",
        stepId: step.stepId,
        invocationId: attempt.invocationId,
        attempt: attempt.attempt,
      });
    }
  }
  return decisions;
}

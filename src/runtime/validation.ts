import { posix, win32 } from "node:path";

import {
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  type RetryableOutcome,
  type WorkflowDefinition,
  type WorkflowJournalEnvelope,
  type WorkflowRunStatus,
  type WorkflowStepStatus,
} from "./contracts.js";

export interface ContractViolation {
  readonly path: string;
  readonly message: string;
}

export interface ContractSchema<T> {
  readonly name: string;
  readonly contractVersion: number;
  validate(value: unknown): readonly ContractViolation[];
  is(value: unknown): value is T;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const MAX_STEPS = 256;
const MAX_DEPENDENCIES = 64;
const MAX_CAPABILITIES = 64;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_TASK_LENGTH = 100_000;
const MAX_DESCRIPTION_LENGTH = 4_096;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_EVIDENCE_PER_SETTLEMENT = 256;
const MAX_OBJECT_KEYS = 64;
export const MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES = 1_048_576;

function isRecord(value: unknown): value is UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function recordAt(
  value: unknown,
  path: string,
  issues: ContractViolation[],
): UnknownRecord | undefined {
  if (!isRecord(value)) {
    issues.push({ path, message: "must be an object" });
    return undefined;
  }
  return value;
}

function rejectUnknownKeys(
  value: UnknownRecord,
  allowed: readonly string[],
  path: string,
  issues: ContractViolation[],
): void {
  const allowedKeys = new Set(allowed);
  let keyCount = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    keyCount += 1;
    if (keyCount > MAX_OBJECT_KEYS) {
      issues.push({ path, message: `must not contain more than ${MAX_OBJECT_KEYS} properties` });
      break;
    }
    if (!allowedKeys.has(key)) issues.push({ path: `${path}.${key}`, message: "is not supported" });
  }
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

function requireString(
  value: unknown,
  path: string,
  issues: ContractViolation[],
  maxLength = MAX_IDENTIFIER_LENGTH,
): value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    issues.push({ path, message: "must be a non-empty string" });
    return false;
  }
  if (value.length > maxLength) {
    issues.push({ path, message: `must not exceed ${maxLength} characters` });
    return false;
  }
  return true;
}

function requirePositiveInteger(
  value: unknown,
  path: string,
  issues: ContractViolation[],
  maximum = Number.MAX_SAFE_INTEGER,
): value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    issues.push({ path, message: `must be a positive safe integer no greater than ${maximum}` });
    return false;
  }
  return true;
}

function validateStringArray(
  value: unknown,
  path: string,
  issues: ContractViolation[],
  maximumItems: number,
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return undefined;
  }
  if (value.length > maximumItems) {
    issues.push({ path, message: `must not contain more than ${maximumItems} items` });
  }
  const result: string[] = [];
  for (const [index, item] of value.slice(0, maximumItems + 1).entries()) {
    if (requireString(item, `${path}[${index}]`, issues)) result.push(item);
  }
  return result;
}

function validateRetryPolicy(value: unknown, path: string, issues: ContractViolation[]): void {
  const retry = recordAt(value, path, issues);
  if (retry === undefined) return;
  rejectUnknownKeys(retry, ["maxAttempts", "automaticFor"], path, issues);
  requirePositiveInteger(retry["maxAttempts"], `${path}.maxAttempts`, issues, 100);
  const automaticFor = validateStringArray(retry["automaticFor"], `${path}.automaticFor`, issues, 3);
  const allowed = new Set<RetryableOutcome>(["failed", "cancelled", "timedOut"]);
  if (automaticFor !== undefined) {
    const seen = new Set<string>();
    for (const [index, outcome] of automaticFor.entries()) {
      if (!allowed.has(outcome as RetryableOutcome)) {
        issues.push({ path: `${path}.automaticFor[${index}]`, message: "is not retryable" });
      }
      if (seen.has(outcome)) {
        issues.push({ path: `${path}.automaticFor[${index}]`, message: "must be unique" });
      }
      seen.add(outcome);
    }
  }
}

function validateInvocation(value: unknown, path: string, issues: ContractViolation[]): void {
  const invocation = recordAt(value, path, issues);
  if (invocation === undefined) return;
  rejectUnknownKeys(
    invocation,
    ["agent", "task", "requestedCapabilities", "timeoutMs"],
    path,
    issues,
  );
  requireString(invocation["agent"], `${path}.agent`, issues);
  requireString(invocation["task"], `${path}.task`, issues, MAX_TASK_LENGTH);
  const capabilities = validateStringArray(
    invocation["requestedCapabilities"],
    `${path}.requestedCapabilities`,
    issues,
    MAX_CAPABILITIES,
  );
  if (capabilities !== undefined && new Set(capabilities).size !== capabilities.length) {
    issues.push({ path: `${path}.requestedCapabilities`, message: "must contain unique values" });
  }
  if (invocation["timeoutMs"] !== undefined) {
    requirePositiveInteger(invocation["timeoutMs"], `${path}.timeoutMs`, issues, 86_400_000);
  }
}

function detectDependencyCycles(
  dependencies: ReadonlyMap<string, readonly string[]>,
  issues: ContractViolation[],
): void {
  const color = new Map<string, "visiting" | "complete">();
  for (const start of dependencies.keys()) {
    if (color.has(start)) continue;
    const stack: { readonly stepId: string; index: number }[] = [{ stepId: start, index: 0 }];
    color.set(start, "visiting");
    while (stack.length > 0) {
      const frame = stack.at(-1);
      if (frame === undefined) break;
      const edges = dependencies.get(frame.stepId) ?? [];
      const dependency = edges[frame.index];
      if (dependency === undefined) {
        color.set(frame.stepId, "complete");
        stack.pop();
        continue;
      }
      frame.index += 1;
      const dependencyColor = color.get(dependency);
      if (dependencyColor === "visiting") {
        issues.push({ path: "$.steps", message: `contains dependency cycle through '${dependency}'` });
        return;
      }
      if (dependencyColor === undefined && dependencies.has(dependency)) {
        color.set(dependency, "visiting");
        stack.push({ stepId: dependency, index: 0 });
      }
    }
  }
}

function inspectWorkflowDefinition(value: unknown): readonly ContractViolation[] {
  const issues: ContractViolation[] = [];
  const definition = recordAt(value, "$", issues);
  if (definition === undefined) return issues;
  rejectUnknownKeys(definition, ["contractVersion", "workflowId", "description", "steps"], "$", issues);
  if (definition["contractVersion"] !== WORKFLOW_RUNTIME_CONTRACT_VERSION) {
    issues.push({ path: "$.contractVersion", message: `must equal ${WORKFLOW_RUNTIME_CONTRACT_VERSION}` });
  }
  requireString(definition["workflowId"], "$.workflowId", issues);
  if (
    definition["description"] !== undefined &&
    (typeof definition["description"] !== "string" ||
      definition["description"].length > MAX_DESCRIPTION_LENGTH)
  ) {
    issues.push({ path: "$.description", message: `must be a string no longer than ${MAX_DESCRIPTION_LENGTH} characters` });
  }
  if (!Array.isArray(definition["steps"]) || definition["steps"].length === 0) {
    issues.push({ path: "$.steps", message: "must be a non-empty array" });
    return issues;
  }
  if (definition["steps"].length > MAX_STEPS) {
    issues.push({ path: "$.steps", message: `must not contain more than ${MAX_STEPS} steps` });
    return issues;
  }

  const stepIds = new Set<string>();
  const dependencies = new Map<string, readonly string[]>();
  for (const [index, candidate] of definition["steps"].entries()) {
    const path = `$.steps[${index}]`;
    const step = recordAt(candidate, path, issues);
    if (step === undefined) continue;
    rejectUnknownKeys(step, ["stepId", "dependsOn", "invocation", "retry"], path, issues);
    const stepId = step["stepId"];
    const stepIdValid = requireString(stepId, `${path}.stepId`, issues);
    if (stepIdValid) {
      if (stepIds.has(stepId)) issues.push({ path: `${path}.stepId`, message: "must be unique" });
      stepIds.add(stepId);
    }
    const dependsOn = validateStringArray(
      step["dependsOn"],
      `${path}.dependsOn`,
      issues,
      MAX_DEPENDENCIES,
    );
    if (stepIdValid && dependsOn !== undefined) dependencies.set(stepId, dependsOn);
    validateInvocation(step["invocation"], `${path}.invocation`, issues);
    validateRetryPolicy(step["retry"], `${path}.retry`, issues);
  }

  for (const [stepId, dependsOn] of dependencies) {
    const seen = new Set<string>();
    for (const dependency of dependsOn) {
      if (!stepIds.has(dependency)) {
        issues.push({ path: `$.steps.${stepId}.dependsOn`, message: `references unknown step '${dependency}'` });
      }
      if (dependency === stepId) {
        issues.push({ path: `$.steps.${stepId}.dependsOn`, message: "must not reference itself" });
      }
      if (seen.has(dependency)) {
        issues.push({ path: `$.steps.${stepId}.dependsOn`, message: "must contain unique values" });
      }
      seen.add(dependency);
    }
  }
  detectDependencyCycles(dependencies, issues);
  return issues;
}

export function validateWorkflowDefinition(value: unknown): readonly ContractViolation[] {
  try {
    return inspectWorkflowDefinition(value);
  } catch {
    return [{ path: "$", message: "could not be inspected safely" }];
  }
}

function containsOnlyDigits(value: string): boolean {
  for (const character of value) {
    if (character < "0" || character > "9") return false;
  }
  return value.length > 0;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isAbsoluteDateTime(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 20) return false;
  const timezoneStart = value.endsWith("Z") ? value.length - 1 : value.length - 6;
  const timezone = value.slice(timezoneStart);
  if (timezone !== "Z") {
    const offsetHour = Number(timezone.slice(1, 3));
    const offsetMinute = Number(timezone.slice(4, 6));
    if (
      !(timezone.startsWith("+") || timezone.startsWith("-")) ||
      timezone[3] !== ":" ||
      !containsOnlyDigits(timezone.slice(1, 3)) ||
      !containsOnlyDigits(timezone.slice(4, 6)) ||
      offsetHour > 14 ||
      offsetMinute > 59 ||
      (offsetHour === 14 && offsetMinute !== 0)
    ) {
      return false;
    }
  }
  const dateTime = value.slice(0, timezoneStart);
  const fractionStart = dateTime.indexOf(".");
  const base = fractionStart === -1 ? dateTime : dateTime.slice(0, fractionStart);
  const fraction = fractionStart === -1 ? undefined : dateTime.slice(fractionStart + 1);
  if (
    base.length !== 19 ||
    base[4] !== "-" ||
    base[7] !== "-" ||
    base[10] !== "T" ||
    base[13] !== ":" ||
    base[16] !== ":" ||
    !containsOnlyDigits(base.slice(0, 4)) ||
    !containsOnlyDigits(base.slice(5, 7)) ||
    !containsOnlyDigits(base.slice(8, 10)) ||
    !containsOnlyDigits(base.slice(11, 13)) ||
    !containsOnlyDigits(base.slice(14, 16)) ||
    !containsOnlyDigits(base.slice(17, 19)) ||
    (fraction !== undefined && (fraction.length > 9 || !containsOnlyDigits(fraction)))
  ) {
    return false;
  }
  const year = Number(base.slice(0, 4));
  const month = Number(base.slice(5, 7));
  const day = Number(base.slice(8, 10));
  const hour = Number(base.slice(11, 13));
  const minute = Number(base.slice(14, 16));
  const second = Number(base.slice(17, 19));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59
  );
}

function validateScope(value: unknown, path: string, issues: ContractViolation[]): void {
  const scope = recordAt(value, path, issues);
  if (scope === undefined) return;
  rejectUnknownKeys(
    scope,
    ["kind", "scopeId", "digest", "repositoryRoot", "baseRevision", "headRevision", "pullRequestNumber"],
    path,
    issues,
  );
  if (scope["kind"] !== "localChanges" && scope["kind"] !== "pullRequest") {
    issues.push({ path: `${path}.kind`, message: "must be 'localChanges' or 'pullRequest'" });
  }
  requireString(scope["scopeId"], `${path}.scopeId`, issues);
  requireString(scope["digest"], `${path}.digest`, issues);
  if (requireString(scope["repositoryRoot"], `${path}.repositoryRoot`, issues, 4_096)) {
    if (!posix.isAbsolute(scope["repositoryRoot"]) && !win32.isAbsolute(scope["repositoryRoot"])) {
      issues.push({ path: `${path}.repositoryRoot`, message: "must be an absolute path" });
    }
  }
  requireString(scope["baseRevision"], `${path}.baseRevision`, issues);
  if (scope["headRevision"] !== undefined) {
    requireString(scope["headRevision"], `${path}.headRevision`, issues);
  }
  if (scope["kind"] === "pullRequest") {
    requireString(scope["headRevision"], `${path}.headRevision`, issues);
    requirePositiveInteger(scope["pullRequestNumber"], `${path}.pullRequestNumber`, issues);
  } else if (scope["kind"] === "localChanges" && scope["pullRequestNumber"] !== undefined) {
    issues.push({ path: `${path}.pullRequestNumber`, message: "is only valid for pullRequest scope" });
  }
}

function validateAuthorization(value: unknown, path: string, issues: ContractViolation[]): void {
  const authorization = recordAt(value, path, issues);
  if (authorization === undefined) return;
  rejectUnknownKeys(authorization, ["capabilities", "execution", "policyDigest"], path, issues);
  const capabilities = validateStringArray(
    authorization["capabilities"],
    `${path}.capabilities`,
    issues,
    MAX_CAPABILITIES,
  );
  if (capabilities !== undefined && new Set(capabilities).size !== capabilities.length) {
    issues.push({ path: `${path}.capabilities`, message: "must contain unique values" });
  }
  if (authorization["execution"] !== "readOnly" && authorization["execution"] !== "mutating") {
    issues.push({ path: `${path}.execution`, message: "must be 'readOnly' or 'mutating'" });
  }
  requireString(authorization["policyDigest"], `${path}.policyDigest`, issues);
}

function validateFailureSummary(value: unknown, path: string, issues: ContractViolation[]): void {
  const error = recordAt(value, path, issues);
  if (error === undefined) return;
  rejectUnknownKeys(error, ["code", "phase", "retryable"], path, issues);
  const codes = [
    "invalidRequest",
    "spawnFailed",
    "protocolError",
    "agentFailed",
    "processFailed",
    "terminationUnconfirmed",
    "executionUncertain",
    "cleanupFailed",
  ];
  if (!isOneOf(error["code"], codes)) issues.push({ path: `${path}.code`, message: "is not supported" });
  const phases = ["preflight", "dispatch", "execution", "handoff", "cleanup"];
  if (!isOneOf(error["phase"], phases)) issues.push({ path: `${path}.phase`, message: "is not supported" });
  if (typeof error["retryable"] !== "boolean") issues.push({ path: `${path}.retryable`, message: "must be boolean" });
}

function validateOutcome(value: unknown, path: string, issues: ContractViolation[]): UnknownRecord | undefined {
  const outcome = recordAt(value, path, issues);
  if (outcome === undefined) return undefined;
  const status = outcome["status"];
  const common = ["invocationId", "attempt", "inputDigest", "status"];
  if (status === "failed" || status === "indeterminate") {
    rejectUnknownKeys(outcome, [...common, "error"], path, issues);
    validateFailureSummary(outcome["error"], `${path}.error`, issues);
  } else if (status === "cancelled" || status === "timedOut") {
    rejectUnknownKeys(outcome, [...common, "acknowledged"], path, issues);
    if (outcome["acknowledged"] !== true) issues.push({ path: `${path}.acknowledged`, message: "must be true" });
  } else if (status === "succeeded") {
    rejectUnknownKeys(outcome, common, path, issues);
  } else {
    issues.push({ path: `${path}.status`, message: "is not a terminal invocation status" });
  }
  requireString(outcome["invocationId"], `${path}.invocationId`, issues);
  requirePositiveInteger(outcome["attempt"], `${path}.attempt`, issues);
  requireString(outcome["inputDigest"], `${path}.inputDigest`, issues);
  return outcome;
}

function validateEvidence(value: unknown, path: string, issues: ContractViolation[]): void {
  const evidence = recordAt(value, path, issues);
  if (evidence === undefined) return;
  rejectUnknownKeys(
    evidence,
    ["evidenceId", "stepId", "invocationId", "attempt", "inputDigest", "scopeDigest", "valid", "invalidatedBySequence"],
    path,
    issues,
  );
  requireString(evidence["evidenceId"], `${path}.evidenceId`, issues);
  requireString(evidence["stepId"], `${path}.stepId`, issues);
  requireString(evidence["invocationId"], `${path}.invocationId`, issues);
  requirePositiveInteger(evidence["attempt"], `${path}.attempt`, issues);
  requireString(evidence["inputDigest"], `${path}.inputDigest`, issues);
  requireString(evidence["scopeDigest"], `${path}.scopeDigest`, issues);
  if (evidence["valid"] !== true) issues.push({ path: `${path}.valid`, message: "must be true when evidence is recorded" });
  if (evidence["invalidatedBySequence"] !== undefined) {
    issues.push({ path: `${path}.invalidatedBySequence`, message: "must be absent when evidence is recorded" });
  }
}

function validateArtifact(value: unknown, path: string, issues: ContractViolation[]): void {
  const artifact = recordAt(value, path, issues);
  if (artifact === undefined) return;
  rejectUnknownKeys(artifact, ["artifactId", "digest", "mediaType", "byteLength", "storage"], path, issues);
  requireString(artifact["artifactId"], `${path}.artifactId`, issues);
  requireString(artifact["digest"], `${path}.digest`, issues);
  requireString(artifact["mediaType"], `${path}.mediaType`, issues);
  requirePositiveInteger(artifact["byteLength"], `${path}.byteLength`, issues, MAX_ARTIFACT_BYTES);
  if (artifact["storage"] !== "protectedExternal") {
    issues.push({ path: `${path}.storage`, message: "must be 'protectedExternal'" });
  }
}

function validateAttemptIdentityAt(
  value: UnknownRecord,
  path: string,
  issues: ContractViolation[],
): void {
  requireString(value["stepId"], `${path}.stepId`, issues);
  requirePositiveInteger(value["attempt"], `${path}.attempt`, issues);
  requireString(value["invocationId"], `${path}.invocationId`, issues);
  requireString(value["inputDigest"], `${path}.inputDigest`, issues);
}

function validateAttemptIdentity(event: UnknownRecord, issues: ContractViolation[]): void {
  validateAttemptIdentityAt(event, "$.event", issues);
}

function validateActor(value: unknown, path: string, issues: ContractViolation[]): void {
  const actor = recordAt(value, path, issues);
  if (actor === undefined) return;
  rejectUnknownKeys(actor, ["kind", "actorId"], path, issues);
  if (!isOneOf(actor["kind"], ["runtime", "operator"])) {
    issues.push({ path: `${path}.kind`, message: "must be 'runtime' or 'operator'" });
  }
  requireString(actor["actorId"], `${path}.actorId`, issues);
}

function validateSettlement(value: unknown, path: string, issues: ContractViolation[]): void {
  const settlement = recordAt(value, path, issues);
  if (settlement === undefined) return;
  const status = settlement["status"];
  if (status === "succeeded") {
    rejectUnknownKeys(settlement, ["status", "invocationId", "attempt", "inputDigest", "evidenceIds"], path, issues);
    requireString(settlement["invocationId"], `${path}.invocationId`, issues);
    requirePositiveInteger(settlement["attempt"], `${path}.attempt`, issues);
    requireString(settlement["inputDigest"], `${path}.inputDigest`, issues);
    const evidenceIds = validateStringArray(settlement["evidenceIds"], `${path}.evidenceIds`, issues, MAX_EVIDENCE_PER_SETTLEMENT);
    if (evidenceIds !== undefined) {
      if (evidenceIds.length === 0) issues.push({ path: `${path}.evidenceIds`, message: "must not be empty" });
      if (new Set(evidenceIds).size !== evidenceIds.length) {
        issues.push({ path: `${path}.evidenceIds`, message: "must contain unique values" });
      }
    }
    return;
  }
  if (status === "failed" || status === "indeterminate") {
    rejectUnknownKeys(settlement, ["status", "invocationId", "attempt", "inputDigest", "reason"], path, issues);
    requireString(settlement["invocationId"], `${path}.invocationId`, issues);
    requirePositiveInteger(settlement["attempt"], `${path}.attempt`, issues);
    requireString(settlement["inputDigest"], `${path}.inputDigest`, issues);
    const reasons = status === "failed"
      ? ["attemptOutcome", "retryDeclined"]
      : ["attemptOutcome", "recoveryAborted"];
    if (!isOneOf(settlement["reason"], reasons)) {
      issues.push({ path: `${path}.reason`, message: "is not a supported terminal reason" });
    }
    return;
  }
  if (status === "cancelled") {
    rejectUnknownKeys(settlement, ["status", "reason"], path, issues);
    if (!isOneOf(settlement["reason"], ["operatorRequested", "hostShutdown", "superseded"])) {
      issues.push({ path: `${path}.reason`, message: "is not a supported cancellation reason" });
    }
    return;
  }
  if (status === "blocked") {
    rejectUnknownKeys(settlement, ["status", "blockedBy"], path, issues);
    requireString(settlement["blockedBy"], `${path}.blockedBy`, issues);
    return;
  }
  issues.push({ path: `${path}.status`, message: "must be a terminal step status" });
}

function validateRecoveryResolution(value: unknown, path: string, event: UnknownRecord, issues: ContractViolation[]): void {
  const resolution = recordAt(value, path, issues);
  if (resolution === undefined) return;
  if (resolution["kind"] === "outcomeConfirmed") {
    rejectUnknownKeys(resolution, ["kind", "outcome"], path, issues);
    const outcome = validateOutcome(resolution["outcome"], `${path}.outcome`, issues);
    if (outcome !== undefined) {
      if (outcome["invocationId"] !== event["invocationId"]) {
        issues.push({ path: `${path}.outcome.invocationId`, message: "must match the event invocationId" });
      }
      if (outcome["attempt"] !== event["attempt"]) {
        issues.push({ path: `${path}.outcome.attempt`, message: "must match the event attempt" });
      }
      if (outcome["inputDigest"] !== event["inputDigest"]) {
        issues.push({ path: `${path}.outcome.inputDigest`, message: "must match the event inputDigest" });
      }
    }
    return;
  }
  rejectUnknownKeys(resolution, ["kind"], path, issues);
  if (!isOneOf(resolution["kind"], ["safeToRetry", "abort"])) {
    issues.push({ path: `${path}.kind`, message: "is not a supported recovery resolution" });
  }
}

function validateEvent(value: unknown, issues: ContractViolation[]): void {
  const event = recordAt(value, "$.event", issues);
  if (event === undefined) return;
  requireString(event["eventId"], "$.event.eventId", issues);
  if (!requireString(event["type"], "$.event.type", issues)) return;
  const common = ["eventId", "type"];
  switch (event["type"]) {
    case "runCreated":
      rejectUnknownKeys(event, [...common, "definition", "definitionDigest", "scope"], "$.event", issues);
      for (const issue of validateWorkflowDefinition(event["definition"])) {
        issues.push({ path: `$.event.definition${issue.path.slice(1)}`, message: issue.message });
      }
      requireString(event["definitionDigest"], "$.event.definitionDigest", issues);
      validateScope(event["scope"], "$.event.scope", issues);
      break;
    case "runStarted":
      rejectUnknownKeys(event, common, "$.event", issues);
      break;
    case "stepReady":
      rejectUnknownKeys(event, [...common, "stepId"], "$.event", issues);
      requireString(event["stepId"], "$.event.stepId", issues);
      break;
    case "attemptPlanned":
      rejectUnknownKeys(event, [...common, "stepId", "attempt", "invocationId", "inputDigest", "deadlineAt", "authorization"], "$.event", issues);
      validateAttemptIdentity(event, issues);
      if (event["deadlineAt"] !== undefined && !isAbsoluteDateTime(event["deadlineAt"])) {
        issues.push({ path: "$.event.deadlineAt", message: "must be an absolute ISO-8601 timestamp" });
      }
      validateAuthorization(event["authorization"], "$.event.authorization", issues);
      break;
    case "attemptStarted":
      rejectUnknownKeys(event, [...common, "stepId", "attempt", "invocationId", "inputDigest"], "$.event", issues);
      validateAttemptIdentity(event, issues);
      break;
    case "attemptSettled": {
      rejectUnknownKeys(event, [...common, "stepId", "attempt", "invocationId", "inputDigest", "outcome"], "$.event", issues);
      validateAttemptIdentity(event, issues);
      const outcome = validateOutcome(event["outcome"], "$.event.outcome", issues);
      if (outcome !== undefined) {
        if (outcome["invocationId"] !== event["invocationId"]) {
          issues.push({ path: "$.event.outcome.invocationId", message: "must match the event invocationId" });
        }
        if (outcome["attempt"] !== event["attempt"]) {
          issues.push({ path: "$.event.outcome.attempt", message: "must match the event attempt" });
        }
        if (outcome["inputDigest"] !== event["inputDigest"]) {
          issues.push({ path: "$.event.outcome.inputDigest", message: "must match the event inputDigest" });
        }
      }
      break;
    }
    case "evidenceRecorded":
      rejectUnknownKeys(event, [...common, "evidence", "artifact"], "$.event", issues);
      validateEvidence(event["evidence"], "$.event.evidence", issues);
      if (event["artifact"] !== undefined) validateArtifact(event["artifact"], "$.event.artifact", issues);
      break;
    case "evidenceInvalidated":
      rejectUnknownKeys(event, [...common, "evidenceId", "reason"], "$.event", issues);
      requireString(event["evidenceId"], "$.event.evidenceId", issues);
      if (!isOneOf(event["reason"], ["scopeChanged", "inputChanged", "superseded", "manual"])) {
        issues.push({ path: "$.event.reason", message: "is not a supported invalidation reason" });
      }
      break;
    case "attemptRecoveryRequired":
      rejectUnknownKeys(event, [...common, "stepId", "attempt", "invocationId", "inputDigest", "execution", "reason"], "$.event", issues);
      validateAttemptIdentity(event, issues);
      if (event["execution"] !== "readOnly" && event["execution"] !== "mutating") {
        issues.push({ path: "$.event.execution", message: "must be 'readOnly' or 'mutating'" });
      }
      if (!isOneOf(event["reason"], ["hostRestart", "journalInterrupted", "terminationUnconfirmed"])) {
        issues.push({ path: "$.event.reason", message: "is not a supported recovery reason" });
      }
      break;
    case "attemptRecoveryResolved":
      rejectUnknownKeys(event, [...common, "stepId", "attempt", "invocationId", "inputDigest", "resolution"], "$.event", issues);
      validateAttemptIdentity(event, issues);
      validateRecoveryResolution(event["resolution"], "$.event.resolution", event, issues);
      break;
    case "stepSettled":
      rejectUnknownKeys(event, [...common, "stepId", "settlement"], "$.event", issues);
      requireString(event["stepId"], "$.event.stepId", issues);
      validateSettlement(event["settlement"], "$.event.settlement", issues);
      break;
    case "cancellationRequested":
      rejectUnknownKeys(event, [...common, "reason"], "$.event", issues);
      if (!isOneOf(event["reason"], ["operatorRequested", "hostShutdown", "superseded"])) {
        issues.push({ path: "$.event.reason", message: "is not a supported cancellation reason" });
      }
      break;
    case "runSettled":
      rejectUnknownKeys(event, [...common, "status"], "$.event", issues);
      if (!isOneOf(event["status"], ["succeeded", "failed", "cancelled", "indeterminate"])) {
        issues.push({ path: "$.event.status", message: "must be terminal" });
      }
      break;
    default:
      issues.push({ path: "$.event.type", message: "is not supported" });
  }
}

export type WorkflowJournalParseResult =
  | { readonly ok: true; readonly value: WorkflowJournalEnvelope }
  | { readonly ok: false; readonly violations: readonly ContractViolation[] };

export function parseWorkflowJournalEnvelopeJson(json: string): WorkflowJournalParseResult {
  if (Buffer.byteLength(json, "utf8") > MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES) {
    return {
      ok: false,
      violations: [{ path: "$", message: `must not exceed ${MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES} bytes` }],
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(json) as unknown;
  } catch {
    return { ok: false, violations: [{ path: "$", message: "must be valid JSON" }] };
  }
  const violations = validateWorkflowJournalEnvelope(value);
  if (violations.length > 0) return { ok: false, violations };
  return { ok: true, value: value as WorkflowJournalEnvelope };
}

function inspectWorkflowJournalEnvelope(value: unknown): readonly ContractViolation[] {
  const issues: ContractViolation[] = [];
  const envelope = recordAt(value, "$", issues);
  if (envelope === undefined) return issues;
  rejectUnknownKeys(envelope, ["contractVersion", "runId", "sequence", "occurredAt", "actor", "event"], "$", issues);
  if (envelope["contractVersion"] !== WORKFLOW_RUNTIME_CONTRACT_VERSION) {
    issues.push({ path: "$.contractVersion", message: `must equal ${WORKFLOW_RUNTIME_CONTRACT_VERSION}` });
  }
  requireString(envelope["runId"], "$.runId", issues);
  requirePositiveInteger(envelope["sequence"], "$.sequence", issues);
  if (!isAbsoluteDateTime(envelope["occurredAt"])) {
    issues.push({ path: "$.occurredAt", message: "must be an absolute ISO-8601 timestamp" });
  }
  validateActor(envelope["actor"], "$.actor", issues);
  validateEvent(envelope["event"], issues);
  return issues;
}

export function validateWorkflowJournalEnvelope(value: unknown): readonly ContractViolation[] {
  try {
    return inspectWorkflowJournalEnvelope(value);
  } catch {
    return [{ path: "$", message: "could not be inspected safely" }];
  }
}

export const WORKFLOW_DEFINITION_SCHEMA: ContractSchema<WorkflowDefinition> = {
  name: "WorkflowDefinition",
  contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
  validate: validateWorkflowDefinition,
  is: (value: unknown): value is WorkflowDefinition => validateWorkflowDefinition(value).length === 0,
};

export const WORKFLOW_JOURNAL_ENVELOPE_SCHEMA: ContractSchema<WorkflowJournalEnvelope> = {
  name: "WorkflowJournalEnvelope",
  contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
  validate: validateWorkflowJournalEnvelope,
  is: (value: unknown): value is WorkflowJournalEnvelope =>
    validateWorkflowJournalEnvelope(value).length === 0,
};

export function isLegalRunTransition(from: WorkflowRunStatus, to: WorkflowRunStatus): boolean {
  switch (from) {
    case "pending":
      return to === "running" || to === "cancelled";
    case "running":
      return ["succeeded", "failed", "cancelled", "indeterminate"].includes(to);
    case "succeeded":
    case "failed":
    case "cancelled":
    case "indeterminate":
      return false;
  }
}

export function isLegalStepTransition(from: WorkflowStepStatus, to: WorkflowStepStatus): boolean {
  switch (from) {
    case "pending":
      return to === "ready" || to === "blocked" || to === "cancelled";
    case "ready":
      return to === "running" || to === "cancelled";
    case "running":
      return ["ready", "succeeded", "failed", "cancelled", "indeterminate"].includes(to);
    case "succeeded":
    case "failed":
    case "cancelled":
    case "indeterminate":
    case "blocked":
      return false;
  }
}

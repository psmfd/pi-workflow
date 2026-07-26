import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES,
  WORKFLOW_DEFINITION_SCHEMA,
  WORKFLOW_JOURNAL_ENVELOPE_SCHEMA,
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  isLegalRunTransition,
  isLegalStepTransition,
  parseWorkflowJournalEnvelopeJson,
} from "../src/index.js";

function validDefinition(): Record<string, unknown> {
  return {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    workflowId: "review.local",
    description: "Review local changes deterministically.",
    steps: [
      {
        stepId: "collect",
        dependsOn: [],
        invocation: {
          agent: "code-review-expert",
          task: "Review the canonical scope.",
          requestedCapabilities: ["read", "git_read"],
          timeoutMs: 60_000,
        },
        retry: { maxAttempts: 2, automaticFor: ["failed", "timedOut"] },
      },
      {
        stepId: "summarize",
        dependsOn: ["collect"],
        invocation: {
          agent: "docs-expert",
          task: "Summarize validated findings.",
          requestedCapabilities: ["read"],
        },
        retry: { maxAttempts: 1, automaticFor: [] },
      },
    ],
  };
}

void test("workflow definition schema accepts a typed acyclic workflow", () => {
  const definition = validDefinition();
  assert.equal(WORKFLOW_DEFINITION_SCHEMA.is(definition), true);
  assert.deepEqual(WORKFLOW_DEFINITION_SCHEMA.validate(definition), []);
});

void test("workflow definition schema rejects version drift and unknown fields", () => {
  const definition = { ...validDefinition(), contractVersion: 2, yaml: "not-supported" };
  const violations = WORKFLOW_DEFINITION_SCHEMA.validate(definition);
  assert.ok(violations.some(({ path }) => path === "$.contractVersion"));
  assert.ok(violations.some(({ path }) => path === "$.yaml"));
});

void test("workflow definition schema rejects duplicate, missing, and cyclic dependencies", () => {
  const definition = validDefinition();
  const steps = definition["steps"] as Record<string, unknown>[];
  steps.push({
    ...(steps[0] as Record<string, unknown>),
    dependsOn: ["summarize", "missing", "missing"],
  });
  const summarize = steps[1] as Record<string, unknown>;
  summarize["dependsOn"] = ["collect", "summarize"];

  const messages = WORKFLOW_DEFINITION_SCHEMA.validate(definition).map(
    ({ message }) => message,
  );
  assert.ok(messages.includes("must be unique"));
  assert.ok(messages.some((message) => message.includes("unknown step 'missing'")));
  assert.ok(messages.includes("must not reference itself"));
  assert.ok(messages.some((message) => message.includes("dependency cycle")));
});

void test("retry schema fails closed for indeterminate work", () => {
  const definition = validDefinition();
  const steps = definition["steps"] as Record<string, unknown>[];
  const first = steps[0] as Record<string, unknown>;
  first["retry"] = { maxAttempts: 2, automaticFor: ["indeterminate"] };

  const violations = WORKFLOW_DEFINITION_SCHEMA.validate(definition);
  assert.ok(violations.some(({ message }) => message === "is not retryable"));
});

void test("journal schema requires absolute timestamps and fenced attempt identity", () => {
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 3,
    occurredAt: "2026-07-25T22:27:59Z",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-3",
      type: "attemptSettled",
      stepId: "collect",
      attempt: 2,
      invocationId: "invocation-2",
      inputDigest: "input-2",
      outcome: {
        invocationId: "stale-invocation",
        attempt: 1,
        inputDigest: "stale-input",
        status: "succeeded",
      },
    },
  };

  const violations = WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope);
  assert.ok(violations.some(({ path }) => path === "$.event.outcome.invocationId"));
  assert.ok(violations.some(({ path }) => path === "$.event.outcome.attempt"));
  assert.ok(violations.some(({ path }) => path === "$.event.outcome.inputDigest"));

  envelope.event.outcome.invocationId = "invocation-2";
  envelope.event.outcome.attempt = 2;
  envelope.event.outcome.inputDigest = "input-2";
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope), []);

  envelope.occurredAt = "2026-07-25T22:27:59";
  assert.ok(
    WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope).some(
      ({ path }) => path === "$.occurredAt",
    ),
  );
  envelope.occurredAt = "2026-02-30T22:27:59Z";
  assert.ok(
    WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope).some(
      ({ path }) => path === "$.occurredAt",
    ),
  );
});

void test("run creation validates scope fields and pull-request invariants strictly", () => {
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 1,
    occurredAt: "2026-07-25T22:27:59.123Z",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-1",
      type: "runCreated",
      definition: validDefinition(),
      definitionDigest: "definition-digest",
      scope: {
        kind: "pullRequest",
        scopeId: "pr-27",
        digest: "scope-digest",
        repositoryRoot: "/workspace/repository",
        baseRevision: "base-sha",
        headRevision: "head-sha",
        pullRequestNumber: 27,
      },
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope), []);

  const mutableScope = envelope.event.scope as Record<string, unknown>;
  delete mutableScope["headRevision"];
  Object.assign(mutableScope, { injectedPath: "/other" });
  const violations = WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope);
  assert.ok(violations.some(({ path }) => path === "$.event.scope.headRevision"));
  assert.ok(violations.some(({ path }) => path === "$.event.scope.injectedPath"));
});

void test("settled outcomes are minimized, strict, and fully fenced", () => {
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 4,
    occurredAt: "2026-07-25T22:27:59+00:00",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-4",
      type: "attemptSettled",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      outcome: {
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        status: "failed",
        error: { code: "agentFailed", phase: "execution", retryable: true },
      },
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope), []);

  Object.assign(envelope.event.outcome, { output: "must not enter the journal" });
  assert.ok(
    WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope).some(
      ({ path }) => path === "$.event.outcome.output",
    ),
  );
});

void test("evidence creation stores only fenced references to protected artifacts", () => {
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 5,
    occurredAt: "2026-07-25T22:27:59Z",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-5",
      type: "evidenceRecorded",
      evidence: {
        evidenceId: "evidence-1",
        stepId: "review",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        scopeDigest: "scope-1",
        valid: true,
      },
      artifact: {
        artifactId: "artifact-1",
        digest: "artifact-digest",
        mediaType: "text/markdown",
        byteLength: 512,
        storage: "protectedExternal",
      },
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope), []);

  envelope.event.artifact.storage = "inline";
  assert.ok(
    WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope).some(
      ({ path }) => path === "$.event.artifact.storage",
    ),
  );
});

void test("recovery is represented durably before interrupted attempts proceed", () => {
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 6,
    occurredAt: "2026-07-25T22:27:59Z",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-6",
      type: "attemptRecoveryRequired",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      execution: "mutating",
      reason: "hostRestart",
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope), []);
});

void test("actor, step settlement, and recovery resolution are strict and outcome-fenced", () => {
  const settlement = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 7,
    occurredAt: "2026-07-25T22:27:59Z",
    actor: { kind: "operator", actorId: "operator-1" },
    event: {
      eventId: "event-7",
      type: "stepSettled",
      stepId: "review",
      settlement: {
        status: "succeeded",
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        evidenceIds: ["evidence-1"],
      },
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(settlement), []);
  settlement.event.settlement.evidenceIds.push("evidence-1");
  assert.ok(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(settlement).some(
    ({ path }) => path === "$.event.settlement.evidenceIds",
  ));

  const recovery = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 8,
    occurredAt: "2026-07-25T22:28:00Z",
    actor: { kind: "operator", actorId: "operator-1" },
    event: {
      eventId: "event-8",
      type: "attemptRecoveryResolved",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      resolution: {
        kind: "outcomeConfirmed",
        outcome: {
          status: "succeeded",
          attempt: 1,
          invocationId: "invocation-1",
          inputDigest: "input-1",
        },
      },
    },
  };
  assert.deepEqual(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(recovery), []);
  recovery.event.resolution.outcome.invocationId = "stale";
  assert.ok(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(recovery).some(
    ({ path }) => path === "$.event.resolution.outcome.invocationId",
  ));

  delete (recovery as { actor?: unknown }).actor;
  assert.ok(WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(recovery).some(
    ({ path }) => path === "$.actor",
  ));
});

void test("definition bounds reject oversized workflow graphs before traversal", () => {
  const definition = validDefinition();
  const template = (definition["steps"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  definition["steps"] = Array.from({ length: 257 }, (_, index) => ({
    ...template,
    stepId: `step-${index}`,
  }));
  assert.ok(
    WORKFLOW_DEFINITION_SCHEMA.validate(definition).some(
      ({ message }) => message === "must not contain more than 256 steps",
    ),
  );
});

void test("validation returns violations for hostile enum values instead of throwing", () => {
  const hostileValue = Object.create(null) as Record<string, unknown>;
  const envelope = {
    contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
    runId: "run-1",
    sequence: 4,
    occurredAt: "2026-07-25T22:27:59Z",
    actor: { kind: "runtime", actorId: "runtime-1" },
    event: {
      eventId: "event-4",
      type: "attemptSettled",
      stepId: "review",
      attempt: 1,
      invocationId: "invocation-1",
      inputDigest: "input-1",
      outcome: {
        invocationId: "invocation-1",
        attempt: 1,
        inputDigest: "input-1",
        status: "failed",
        error: { code: hostileValue, phase: "execution", retryable: false },
      },
    },
  };
  assert.doesNotThrow(() => WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope));
  assert.ok(
    WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(envelope).some(
      ({ path }) => path === "$.event.outcome.error.code",
    ),
  );
});

void test("public validators fail closed for throwing accessors and proxies", () => {
  const throwingAccessor = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(throwingAccessor, "contractVersion", {
    enumerable: true,
    get: () => {
      throw new Error("hostile accessor");
    },
  });
  const throwingProxy = new Proxy(
    {},
    {
      getPrototypeOf: () => {
        throw new Error("hostile proxy");
      },
    },
  );

  for (const value of [throwingAccessor, throwingProxy]) {
    assert.doesNotThrow(() => WORKFLOW_DEFINITION_SCHEMA.validate(value));
    assert.deepEqual(WORKFLOW_DEFINITION_SCHEMA.validate(value), [
      { path: "$", message: "could not be inspected safely" },
    ]);
    assert.equal(WORKFLOW_DEFINITION_SCHEMA.is(value), false);
    assert.doesNotThrow(() => WORKFLOW_JOURNAL_ENVELOPE_SCHEMA.validate(value));
  }
});

void test("validation bounds object width and serialized journal input", () => {
  const wideDefinition = validDefinition();
  for (let index = 0; index < 1_000; index += 1) wideDefinition[`unknown-${index}`] = index;
  const violations = WORKFLOW_DEFINITION_SCHEMA.validate(wideDefinition);
  assert.ok(violations.some(({ message }) => message === "must not contain more than 64 properties"));
  assert.ok(violations.length <= 65);

  const oversized = `"${"x".repeat(MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES)}"`;
  const result = parseWorkflowJournalEnvelopeJson(oversized);
  assert.equal(result.ok, false);
});

void test("transition contracts are monotonic after terminal states", () => {
  assert.equal(isLegalRunTransition("pending", "running"), true);
  assert.equal(isLegalRunTransition("running", "succeeded"), true);
  assert.equal(isLegalRunTransition("succeeded", "running"), false);
  assert.equal(isLegalRunTransition("failed", "running"), false);

  assert.equal(isLegalStepTransition("pending", "ready"), true);
  assert.equal(isLegalStepTransition("running", "ready"), true);
  assert.equal(isLegalStepTransition("running", "indeterminate"), true);
  assert.equal(isLegalStepTransition("indeterminate", "ready"), false);
  assert.equal(isLegalStepTransition("blocked", "running"), false);
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  reduceWorkflowJournalEnvelope,
  replayWorkflowJournal,
  type WorkflowJournalEnvelope,
  type WorkflowRunState,
} from "../src/index.js";
import { creation, envelope, successfulReviewEvents } from "./runtime-fixtures.js";

void test("replay is equivalent to incremental reduction", () => {
  const events = successfulReviewEvents();
  let incremental: WorkflowRunState | undefined;
  for (const candidate of events) {
    const reduced = reduceWorkflowJournalEnvelope(incremental, candidate);
    assert.equal(reduced.ok, true);
    if (reduced.ok) incremental = reduced.state;
  }
  const replayed = replayWorkflowJournal(events);
  assert.equal(replayed.ok, true);
  if (replayed.ok) assert.deepEqual(replayed.state, incremental);
});

void test("replay reports the first illegal sequence and rejects empty journals", () => {
  const empty = replayWorkflowJournal([]);
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.failedSequence, 1);

  const events = [...successfulReviewEvents().slice(0, 2), envelope(4, {
    eventId: "event-4",
    type: "stepReady",
    stepId: "review",
  })];
  const replayed = replayWorkflowJournal(events);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) {
    assert.equal(replayed.failedSequence, 4);
    assert.equal(replayed.error.code, "sequenceMismatch");
  }
});

void test("public replay enforces serialized record bounds", () => {
  const created = creation();
  if (created.event.type !== "runCreated") throw new Error("fixture must create a run");
  const template = created.event.definition.steps[0];
  assert.ok(template);
  const oversized: WorkflowJournalEnvelope = {
    ...created,
    event: {
      ...created.event,
      definition: {
        ...created.event.definition,
        steps: Array.from({ length: 11 }, (_, index) => ({
          ...template,
          stepId: `large-${index}`,
          invocation: { ...template.invocation, task: "x".repeat(100_000) },
        })),
      },
    },
  };
  const replayed = replayWorkflowJournal([oversized]);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) assert.equal(replayed.error.code, "recordTooLarge");
});

void test("public replay stops at the authoritative journal record limit", () => {
  const events = [...successfulReviewEvents().slice(0, 6)];
  for (let sequence = 7; sequence <= 4_097; sequence += 1) {
    events.push({
      ...envelope(sequence, {
        eventId: `event-${sequence}`,
        type: "evidenceRecorded",
        evidence: {
          evidenceId: `evidence-${sequence}`,
          stepId: "review",
          invocationId: "invocation-1",
          attempt: 1,
          inputDigest: "input-1",
          scopeDigest: "scope-digest",
          valid: true,
        },
      }),
      occurredAt: "2026-07-26T00:00:30Z",
    });
  }
  const replayed = replayWorkflowJournal(events);
  assert.equal(replayed.ok, false);
  if (!replayed.ok) {
    assert.equal(replayed.failedSequence, 4_097);
    assert.equal(replayed.error.code, "tooManyRecords");
  }
});

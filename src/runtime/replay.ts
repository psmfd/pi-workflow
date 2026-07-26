import type { WorkflowJournalEnvelope, WorkflowRunState } from "./contracts.js";
import {
  MAX_WORKFLOW_JOURNAL_BYTES,
  MAX_WORKFLOW_JOURNAL_RECORDS,
} from "./limits.js";
import {
  createWorkflowReductionContext,
  materializeWorkflowEventIds,
  reduceWorkflowJournalEnvelopeWithContext,
  type WorkflowReductionError,
} from "./reducer.js";
import {
  MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES,
  validateWorkflowJournalEnvelope,
} from "./validation.js";

export type WorkflowReplayError = WorkflowReductionError | {
  readonly code: "tooManyRecords" | "recordTooLarge" | "journalTooLarge";
  readonly message: string;
};

export type WorkflowReplayResult =
  | { readonly ok: true; readonly state: WorkflowRunState }
  | {
      readonly ok: false;
      readonly failedSequence: number;
      readonly error: WorkflowReplayError;
    };

/** Replay ordered envelopes through the same reducer used for live appends. */
export function replayWorkflowJournal(
  envelopes: Iterable<WorkflowJournalEnvelope>,
): WorkflowReplayResult {
  let state: WorkflowRunState | undefined;
  let sawEnvelope = false;
  const context = createWorkflowReductionContext();
  let recordCount = 0;
  let byteLength = 0;
  for (const envelope of envelopes) {
    recordCount += 1;
    if (recordCount > MAX_WORKFLOW_JOURNAL_RECORDS) {
      return {
        ok: false,
        failedSequence: envelope.sequence,
        error: { code: "tooManyRecords", message: "journal exceeds the configured record limit" },
      };
    }
    if (validateWorkflowJournalEnvelope(envelope).length > 0) {
      return {
        ok: false,
        failedSequence: envelope.sequence,
        error: { code: "invalidEnvelope", message: "journal envelope does not satisfy the contract schema" },
      };
    }
    let serialized: string;
    try {
      serialized = JSON.stringify(envelope);
    } catch {
      return {
        ok: false,
        failedSequence: envelope.sequence,
        error: { code: "invalidEnvelope", message: "journal envelope cannot be serialized" },
      };
    }
    const recordBytes = Buffer.byteLength(serialized, "utf8");
    if (recordBytes > MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES) {
      return {
        ok: false,
        failedSequence: envelope.sequence,
        error: { code: "recordTooLarge", message: "journal record exceeds the configured byte limit" },
      };
    }
    byteLength += recordBytes + 1;
    if (byteLength > MAX_WORKFLOW_JOURNAL_BYTES) {
      return {
        ok: false,
        failedSequence: envelope.sequence,
        error: { code: "journalTooLarge", message: "journal exceeds the configured byte limit" },
      };
    }
    sawEnvelope = true;
    const reduced = reduceWorkflowJournalEnvelopeWithContext(state, envelope, context);
    if (!reduced.ok) {
      return { ok: false, failedSequence: envelope.sequence, error: reduced.error };
    }
    state = reduced.state;
  }
  if (!sawEnvelope || state === undefined) {
    return {
      ok: false,
      failedSequence: 1,
      error: { code: "invalidFirstEvent", message: "journal must contain a run creation event" },
    };
  }
  return { ok: true, state: materializeWorkflowEventIds(state, context) };
}

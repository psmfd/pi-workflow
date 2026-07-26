/* eslint-disable security/detect-non-literal-fs-filename -- paths are confined to an explicit private root and hash-derived filenames */
/* eslint-disable security/detect-object-injection -- byte-buffer indexes are bounded by buffer length */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  open,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";

import type {
  WorkflowJournalActor,
  WorkflowJournalEnvelope,
  WorkflowRunState,
} from "./contracts.js";
import {
  createWorkflowReductionContext,
  materializeWorkflowEventIds,
  reduceWorkflowJournalEnvelopeWithContext,
  type WorkflowReductionContext,
} from "./reducer.js";
import {
  MAX_WORKFLOW_JOURNAL_BYTES,
  MAX_WORKFLOW_JOURNAL_RECORDS,
} from "./limits.js";
import {
  MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES,
  parseWorkflowJournalEnvelopeJson,
  validateWorkflowJournalEnvelope,
} from "./validation.js";

export { MAX_WORKFLOW_JOURNAL_BYTES, MAX_WORKFLOW_JOURNAL_RECORDS } from "./limits.js";

export type WorkflowJournalErrorCode =
  | "invalidRunId"
  | "invalidEnvelope"
  | "actorUnauthorized"
  | "notFound"
  | "locked"
  | "unsafeStorage"
  | "journalTooLarge"
  | "tooManyRecords"
  | "recordTooLarge"
  | "corruptJournal"
  | "illegalTransition"
  | "commitUncertain"
  | "storageFailure";

export interface WorkflowJournalError {
  readonly code: WorkflowJournalErrorCode;
  readonly message: string;
}

export interface WorkflowJournalSnapshot {
  readonly state: WorkflowRunState;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly repairedTrailingBytes: number;
}

export interface WorkflowJournalCommitReceipt {
  readonly runId: string;
  readonly sequence: number;
  readonly eventId: string;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly durable: true;
}

export type WorkflowJournalLoadResult =
  | { readonly ok: true; readonly snapshot: WorkflowJournalSnapshot }
  | { readonly ok: false; readonly error: WorkflowJournalError };

export type WorkflowJournalAppendResult =
  | { readonly ok: true; readonly state: WorkflowRunState; readonly receipt: WorkflowJournalCommitReceipt }
  | { readonly ok: false; readonly error: WorkflowJournalError };

export interface WorkflowJournalStore {
  load(runId: string): Promise<WorkflowJournalLoadResult>;
  append(envelope: WorkflowJournalEnvelope): Promise<WorkflowJournalAppendResult>;
}

export interface FileWorkflowJournalStoreOptions {
  /** Absolute private local-filesystem directory owned by the trusted host. */
  readonly stateRoot: string;
  /** Authenticate host-owned actor metadata before it becomes authoritative. */
  readonly authorizeActor: (actor: WorkflowJournalActor) => boolean | Promise<boolean>;
}

class JournalOperationError extends Error {
  constructor(
    readonly code: WorkflowJournalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JournalOperationError";
  }
}

function operationError(error: unknown, fallback: WorkflowJournalErrorCode = "storageFailure"): WorkflowJournalError {
  if (error instanceof JournalOperationError) return { code: error.code, message: error.message };
  return { code: fallback, message: fallback === "commitUncertain" ? "journal commit outcome is uncertain" : "journal storage operation failed" };
}

function errno(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function validateRunId(runId: string): void {
  if (runId.trim().length === 0 || runId.length > 256) {
    throw new JournalOperationError("invalidRunId", "run identifier must be a non-empty bounded string");
  }
}

function fileStem(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (result.bytesWritten <= 0) {
      throw new JournalOperationError("commitUncertain", "journal write made no progress");
    }
    offset += result.bytesWritten;
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

interface ParsedJournal {
  readonly state: WorkflowRunState | undefined;
  readonly reductionContext: WorkflowReductionContext;
  readonly recordCount: number;
  readonly byteLength: number;
  readonly repairedTrailingBytes: number;
}

async function parseJournal(handle: FileHandle, repairTail: boolean): Promise<ParsedJournal> {
  const stat = await handle.stat();
  if (!stat.isFile()) throw new JournalOperationError("unsafeStorage", "journal path must be a regular file");
  if (stat.size > MAX_WORKFLOW_JOURNAL_BYTES) {
    throw new JournalOperationError("journalTooLarge", "journal exceeds the configured byte limit");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let carry = Buffer.alloc(0);
  let position = 0;
  let committedBytes = 0;
  let recordCount = 0;
  let state: WorkflowRunState | undefined;
  const reductionContext = createWorkflowReductionContext();

  while (position < stat.size) {
    const requested = Math.min(buffer.byteLength, stat.size - position);
    const { bytesRead } = await handle.read(buffer, 0, requested, position);
    if (bytesRead <= 0) throw new JournalOperationError("corruptJournal", "journal ended before its reported size");
    position += bytesRead;
    const chunk = carry.byteLength === 0
      ? Buffer.from(buffer.subarray(0, bytesRead))
      : Buffer.concat([carry, buffer.subarray(0, bytesRead)]);
    let lineStart = 0;
    for (let index = 0; index < chunk.byteLength; index += 1) {
      if (chunk[index] !== 0x0a) continue;
      const line = chunk.subarray(lineStart, index);
      if (line.byteLength === 0 || line.at(-1) === 0x0d) {
        throw new JournalOperationError("corruptJournal", "journal contains a non-canonical record");
      }
      if (line.byteLength > MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES) {
        throw new JournalOperationError("recordTooLarge", "journal record exceeds the configured byte limit");
      }
      recordCount += 1;
      if (recordCount > MAX_WORKFLOW_JOURNAL_RECORDS) {
        throw new JournalOperationError("tooManyRecords", "journal exceeds the configured record limit");
      }
      let text: string;
      try {
        text = decoder.decode(line);
      } catch {
        throw new JournalOperationError("corruptJournal", "journal record is not valid UTF-8");
      }
      const parsed = parseWorkflowJournalEnvelopeJson(text);
      if (!parsed.ok) throw new JournalOperationError("corruptJournal", "journal contains an invalid envelope");
      const reduced = reduceWorkflowJournalEnvelopeWithContext(state, parsed.value, reductionContext);
      if (!reduced.ok) throw new JournalOperationError("corruptJournal", "journal contains an illegal transition");
      state = reduced.state;
      committedBytes += line.byteLength + 1;
      lineStart = index + 1;
    }
    carry = Buffer.from(chunk.subarray(lineStart));
    if (carry.byteLength > MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES) {
      throw new JournalOperationError("recordTooLarge", "journal trailing record exceeds the configured byte limit");
    }
  }

  let repairedTrailingBytes = 0;
  if (carry.byteLength > 0) {
    if (!repairTail) throw new JournalOperationError("corruptJournal", "journal has an unterminated trailing record");
    repairedTrailingBytes = carry.byteLength;
    try {
      await handle.truncate(committedBytes);
      await handle.sync();
    } catch {
      throw new JournalOperationError("commitUncertain", "torn-tail repair outcome is uncertain");
    }
  }
  return {
    state: state === undefined ? undefined : materializeWorkflowEventIds(state, reductionContext),
    reductionContext,
    recordCount,
    byteLength: committedBytes,
    repairedTrailingBytes,
  };
}

/** File-backed authoritative journal with per-run cooperative cross-process locking. */
export class FileWorkflowJournalStore implements WorkflowJournalStore {
  readonly #stateRoot: string;
  readonly #authorizeActor: FileWorkflowJournalStoreOptions["authorizeActor"];
  readonly #queues = new Map<string, Promise<void>>();

  constructor(options: FileWorkflowJournalStoreOptions) {
    if (!isAbsolute(options.stateRoot)) {
      throw new TypeError("stateRoot must be an absolute path");
    }
    if (typeof options.authorizeActor !== "function") {
      throw new TypeError("authorizeActor must be a function");
    }
    this.#stateRoot = options.stateRoot;
    this.#authorizeActor = options.authorizeActor;
  }

  async #ensureRoot(): Promise<void> {
    const stat = await lstat(this.#stateRoot);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new JournalOperationError("unsafeStorage", "state root must be a real directory");
    }
    if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
      throw new JournalOperationError("unsafeStorage", "state root permissions must exclude group and other access");
    }
  }

  async #serialize<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#queues.get(runId) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const queued = previous.then(() => current);
    this.#queues.set(runId, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
      if (this.#queues.get(runId) === queued) this.#queues.delete(runId);
    }
  }

  async #withLock<T>(runId: string, operation: (journalPath: string) => Promise<T>): Promise<T> {
    await this.#ensureRoot();
    const stem = fileStem(runId);
    const journalPath = join(this.#stateRoot, `${stem}.jsonl`);
    const lockPath = join(this.#stateRoot, `${stem}.lock`);
    let lock: FileHandle;
    try {
      lock = await open(lockPath, "wx", 0o600);
    } catch (error) {
      if (errno(error) === "EEXIST") throw new JournalOperationError("locked", "journal is locked by another writer");
      throw error;
    }
    try {
      await writeAll(lock, Buffer.from(JSON.stringify({ pid: process.pid }), "utf8"));
      await lock.sync();
    } catch (error) {
      let cleanupFailed = false;
      try { await lock.close(); } catch { cleanupFailed = true; }
      try {
        await unlink(lockPath);
        await syncDirectory(this.#stateRoot);
      } catch {
        cleanupFailed = true;
      }
      if (cleanupFailed) throw new JournalOperationError("storageFailure", "lock acquisition cleanup failed");
      if (error instanceof Error) throw error;
      throw new JournalOperationError("storageFailure", "lock acquisition failed");
    }

    let result: T | undefined;
    let operationFailure: unknown;
    try {
      result = await operation(journalPath);
    } catch (error) {
      operationFailure = error;
    }
    let cleanupFailed = false;
    try {
      await lock.close();
    } catch {
      cleanupFailed = true;
    }
    try {
      await unlink(lockPath);
      await syncDirectory(this.#stateRoot);
    } catch {
      cleanupFailed = true;
    }
    if (cleanupFailed) throw new JournalOperationError("commitUncertain", "journal lock cleanup failed after the operation");
    if (operationFailure instanceof Error) throw operationFailure;
    if (operationFailure !== undefined) throw new JournalOperationError("storageFailure", "journal operation failed");
    return result as T;
  }

  async load(runId: string): Promise<WorkflowJournalLoadResult> {
    try {
      validateRunId(runId);
      return await this.#serialize(runId, async () => this.#withLock(runId, async (journalPath) => {
        let handle: FileHandle;
        try {
          const stat = await lstat(journalPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new JournalOperationError("unsafeStorage", "journal path must be a non-symbolic regular file");
          }
          const noFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
          handle = await open(journalPath, constants.O_RDWR | noFollow);
          const opened = await handle.stat();
          if (!opened.isFile() || (process.platform !== "win32" && (opened.mode & 0o077) !== 0)) {
            await handle.close();
            throw new JournalOperationError("unsafeStorage", "journal must remain a private regular file");
          }
        } catch (error) {
          if (errno(error) === "ENOENT") throw new JournalOperationError("notFound", "journal does not exist");
          throw error;
        }
        try {
          const parsed = await parseJournal(handle, true);
          if (parsed.state === undefined) throw new JournalOperationError("corruptJournal", "journal is empty");
          if (parsed.state.runId !== runId) throw new JournalOperationError("corruptJournal", "journal run identifier does not match its key");
          return {
            ok: true as const,
            snapshot: {
              state: parsed.state,
              recordCount: parsed.recordCount,
              byteLength: parsed.byteLength,
              repairedTrailingBytes: parsed.repairedTrailingBytes,
            },
          };
        } finally {
          await handle.close();
        }
      }));
    } catch (error) {
      return { ok: false, error: operationError(error) };
    }
  }

  async append(envelope: WorkflowJournalEnvelope): Promise<WorkflowJournalAppendResult> {
    if (validateWorkflowJournalEnvelope(envelope).length > 0) {
      return { ok: false, error: { code: "invalidEnvelope", message: "journal envelope does not satisfy the contract schema" } };
    }
    try {
      const candidate = structuredClone(envelope);
      validateRunId(candidate.runId);
      if (!(await this.#authorizeActor(structuredClone(candidate.actor)))) {
        return { ok: false, error: { code: "actorUnauthorized", message: "journal actor is not authorized by the host" } };
      }
      return await this.#serialize(candidate.runId, async () => this.#withLock(candidate.runId, async (journalPath) => {
        try {
          const stat = await lstat(journalPath);
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new JournalOperationError("unsafeStorage", "journal path must be a non-symbolic regular file");
          }
          if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) {
            throw new JournalOperationError("unsafeStorage", "journal permissions must exclude group and other access");
          }
        } catch (error) {
          if (errno(error) !== "ENOENT") throw error;
        }

        let handle: FileHandle;
        try {
          const noFollow = process.platform !== "win32" && typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
          handle = await open(journalPath, constants.O_RDWR | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600);
          const opened = await handle.stat();
          if (!opened.isFile() || (process.platform !== "win32" && (opened.mode & 0o077) !== 0)) {
            await handle.close();
            throw new JournalOperationError("unsafeStorage", "journal must remain a private regular file");
          }
        } catch (error) {
          if (errno(error) === "ELOOP") throw new JournalOperationError("unsafeStorage", "journal path must not be a symbolic link");
          throw error;
        }

        let parsed: ParsedJournal;
        try {
          parsed = await parseJournal(handle, true);
          const reduced = reduceWorkflowJournalEnvelopeWithContext(
            parsed.state,
            candidate,
            parsed.reductionContext,
          );
          if (!reduced.ok) {
            throw new JournalOperationError("illegalTransition", reduced.error.message);
          }
          const record = Buffer.from(`${JSON.stringify(candidate)}\n`, "utf8");
          if (record.byteLength - 1 > MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES) {
            throw new JournalOperationError("recordTooLarge", "journal record exceeds the configured byte limit");
          }
          if (parsed.recordCount + 1 > MAX_WORKFLOW_JOURNAL_RECORDS) {
            throw new JournalOperationError("tooManyRecords", "journal exceeds the configured record limit");
          }
          if (parsed.byteLength + record.byteLength > MAX_WORKFLOW_JOURNAL_BYTES) {
            throw new JournalOperationError("journalTooLarge", "journal exceeds the configured byte limit");
          }
          try {
            await writeAll(handle, record);
            await handle.sync();
            await handle.close();
            await syncDirectory(this.#stateRoot);
          } catch (error) {
            try { await handle.close(); } catch { /* outcome is already uncertain */ }
            if (error instanceof JournalOperationError) throw error;
            throw new JournalOperationError("commitUncertain", "journal commit outcome is uncertain");
          }
          return {
            ok: true as const,
            state: materializeWorkflowEventIds(reduced.state, parsed.reductionContext),
            receipt: {
              runId: candidate.runId,
              sequence: candidate.sequence,
              eventId: candidate.event.eventId,
              recordCount: parsed.recordCount + 1,
              byteLength: parsed.byteLength + record.byteLength,
              durable: true as const,
            },
          };
        } catch (error) {
          try { await handle.close(); } catch { /* preserve the primary classification */ }
          throw error;
        }
      }));
    } catch (error) {
      return { ok: false, error: operationError(error) };
    }
  }
}

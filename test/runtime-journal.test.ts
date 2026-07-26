/* eslint-disable security/detect-non-literal-fs-filename -- tests operate only in fresh private temporary directories */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdtemp, open, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { FileWorkflowJournalStore } from "../src/index.js";
import { creation, envelope, successfulReviewEvents } from "./runtime-fixtures.js";

async function stateRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-workflow-journal-"));
  await chmod(root, 0o700);
  return root;
}

function stem(runId: string): string {
  return createHash("sha256").update(runId, "utf8").digest("hex");
}

function journalStore(root: string): FileWorkflowJournalStore {
  return new FileWorkflowJournalStore({ stateRoot: root, authorizeActor: () => true });
}

void test("file journal durably appends and reloads reduced state", async () => {
  const root = await stateRoot();
  const store = journalStore(root);
  for (const candidate of successfulReviewEvents()) {
    const appended = await store.append(candidate);
    assert.equal(appended.ok, true, appended.ok ? undefined : appended.error.message);
    if (appended.ok) {
      assert.equal(appended.receipt.durable, true);
      assert.equal(appended.receipt.sequence, candidate.sequence);
    }
  }

  const loaded = await store.load("run-1");
  assert.equal(loaded.ok, true, loaded.ok ? undefined : loaded.error.message);
  if (loaded.ok) {
    assert.equal(loaded.snapshot.recordCount, 8);
    assert.equal(loaded.snapshot.state.lastSequence, 8);
    assert.equal(loaded.snapshot.state.steps[0]?.status, "succeeded");
    assert.equal(loaded.snapshot.repairedTrailingBytes, 0);
  }

  const names = await import("node:fs/promises").then(({ readdir }) => readdir(root));
  assert.deepEqual(names, [`${stem("run-1")}.jsonl`]);
  assert.equal(names.some((name) => name.includes("run-1")), false);
});

void test("file journal repairs only an unterminated trailing fragment", async () => {
  const root = await stateRoot();
  const store = journalStore(root);
  assert.equal((await store.append(creation())).ok, true);
  const path = join(root, `${stem("run-1")}.jsonl`);
  const before = (await lstat(path)).size;
  const handle = await open(path, "a");
  await handle.write(Buffer.from("{\"torn\":"));
  await handle.sync();
  await handle.close();

  const loaded = await store.load("run-1");
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.snapshot.repairedTrailingBytes, 8);
  assert.equal((await lstat(path)).size, before);

  const next = await store.append(envelope(2, { eventId: "event-2", type: "runStarted" }));
  assert.equal(next.ok, true);
});

void test("file journal rejects permanent corruption and never skips it", async () => {
  const root = await stateRoot();
  const store = journalStore(root);
  assert.equal((await store.append(creation())).ok, true);
  const path = join(root, `${stem("run-1")}.jsonl`);
  const handle = await open(path, "a");
  await handle.write(Buffer.from("{}\n"));
  await handle.sync();
  await handle.close();

  const loaded = await store.load("run-1");
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.equal(loaded.error.code, "corruptJournal");
  assert.ok((await readFile(path, "utf8")).endsWith("{}\n"));
});

void test("file journal fails closed on lock contention and stale locks", async () => {
  const root = await stateRoot();
  const lockPath = join(root, `${stem("run-1")}.lock`);
  const lock = await open(lockPath, "wx", 0o600);
  await lock.write(Buffer.from("{}"));
  await lock.sync();

  const result = await journalStore(root).append(creation());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "locked");
  await lock.close();
});

void test("cross-store writers cannot commit the same next sequence twice", async () => {
  const root = await stateRoot();
  const first = journalStore(root);
  const second = journalStore(root);
  assert.equal((await first.append(creation())).ok, true);
  const started = envelope(2, { eventId: "event-2", type: "runStarted" });
  const [left, right] = await Promise.all([first.append(started), second.append(started)]);
  assert.equal(Number(left.ok) + Number(right.ok), 1);
  const rejected = left.ok ? right : left;
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.ok(["locked", "illegalTransition"].includes(rejected.error.code));
  const loaded = await first.load("run-1");
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.equal(loaded.snapshot.recordCount, 2);
});

void test("file journal rejects symlink storage objects", { skip: process.platform === "win32" }, async () => {
  const root = await stateRoot();
  const target = join(root, "target");
  const targetHandle = await open(target, "w", 0o600);
  await targetHandle.close();
  await symlink(target, join(root, `${stem("run-1")}.jsonl`));

  const result = await journalStore(root).append(creation());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "unsafeStorage");
});

void test("file journal rejects schema-valid records above the byte limit before commit", async () => {
  const root = await stateRoot();
  const oversized = creation();
  if (oversized.event.type !== "runCreated") throw new Error("fixture must create a run");
  const template = oversized.event.definition.steps[0];
  assert.ok(template);
  const steps = Array.from({ length: 11 }, (_, index) => ({
    ...template,
    stepId: `large-${index}`,
    invocation: { ...template.invocation, task: "x".repeat(100_000) },
  }));
  const candidate = {
    ...oversized,
    event: { ...oversized.event, definition: { ...oversized.event.definition, steps } },
  };
  const result = await journalStore(root).append(candidate);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "recordTooLarge");
});

void test("file journal authenticates actor metadata outside the persisted envelope", async () => {
  const root = await stateRoot();
  const store = new FileWorkflowJournalStore({
    stateRoot: root,
    authorizeActor: (actor) => actor.kind === "operator" && actor.actorId === "approved-operator",
  });
  const result = await store.append(creation());
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "actorUnauthorized");
});

void test("file journal validates absolute private roots and run identifiers", async () => {
  assert.throws(() => new FileWorkflowJournalStore({ stateRoot: "relative", authorizeActor: () => true }), TypeError);
  const root = await stateRoot();
  const store = journalStore(root);
  const missing = await store.load("missing");
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.code, "notFound");
  const invalid = await store.load(" ");
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "invalidRunId");

  const absentRoot = journalStore(join(root, "not-created"));
  const absent = await absentRoot.load("run-1");
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.code, "storageFailure");
});

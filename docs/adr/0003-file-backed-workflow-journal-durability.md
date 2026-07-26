# 3. Use a private synchronized JSONL file as the authoritative run journal

Date: 2026-07-26

## Status

Accepted

## Context and problem statement

ADR 0002 selects an append-only event journal as the authoritative input to the deterministic workflow reducer. Issue #11 must give “append before effect” a physical meaning that survives ordinary process restart, prevents cooperative concurrent writers from selecting the same sequence, distinguishes a torn final write from permanent corruption, and remains independent of pi session files.

Node.js does not provide a portable advisory-lock API. Renaming mutable snapshots cannot replace an audit journal, and storing state in conversation or repository files would mix workflow authority with untrusted or ephemeral data.

## Decision drivers

- Return effect authorization only after the corresponding envelope is synchronized.
- Preserve every committed transition as immutable, replayable input.
- Serialize package processes without relying on platform-specific `flock`.
- Fail closed on uncertain commits, corruption, unsafe file objects, and unsupported data.
- Keep run identifiers out of filesystem paths.
- Bound disk, memory, and replay work.
- Support Linux, macOS, and Windows using Node.js 22 APIs.

## Considered options

1. A private, append-only, synchronized JSONL file with one exclusive-create lock file per run.
2. A mutable JSON snapshot replaced with rename.
3. SQLite or another production persistence dependency.
4. Pi session files or repository-local state.
5. Unlocked appends with optimistic sequence checks.

## Decision outcome

Chosen option: **one private JSONL journal per run, guarded by an exclusive-create lock file and synchronized before commit is reported**.

`FileWorkflowJournalStore` requires an explicit absolute, pre-existing `stateRoot` selected by the trusted host. Requiring pre-creation prevents the store from returning a durable receipt before the parent directory entry naming a newly created root has itself been synchronized. The host must place the root on a private local filesystem and supply an `authorizeActor` callback that authenticates actor metadata outside the serialized envelope. Actor labels are audit data, not self-authenticating authority, and model or workflow input must never select them. The store does not infer a path from a pi session, repository, current directory, or temporary directory. Run IDs are validated and reduced to SHA-256 filenames; user text is never interpolated into a path. The state root contains sensitive operational metadata and is subject to host-defined backup and retention policy; v0.1 never deletes audit journals automatically.

The host creates the root with private access (`0700` on POSIX), and the store creates journal and lock files with `0600`. The store rejects symbolic links and non-regular journal objects, rechecks the opened file, and rejects POSIX journal or root permissions that expose group or other access. Windows relies on the host-protected state root and platform ACLs because POSIX mode bits do not express its access model.

Each record is strict UTF-8 JSON followed by one LF. Limits are 1 MiB per serialized envelope, 64 MiB per journal, and 4,096 records. The record cap bounds cumulative append-and-replay work for v0.1; replay itself uses an ephemeral identity set so one replay is linear in record count. Replay validates the schema and applies the same pure reducer used for live appends. Unsupported versions, malformed newline-terminated records, sequence gaps, duplicate identities, mixed run IDs, and illegal transitions make the journal unusable until explicit operator repair or migration.

### Commit protocol

For each load or append, the store:

1. serializes callers within the process;
2. exclusively creates a hash-derived per-run lock file with `wx`;
3. refuses contention and never guesses that an existing lock is stale;
4. opens and verifies the regular private journal file without following a final symlink where the platform supports `O_NOFOLLOW`;
5. streams and reduces the complete committed prefix;
6. truncates and synchronizes only an unterminated final fragment;
7. validates the proposed next envelope against the replayed state;
8. writes the complete LF-terminated record and rejects zero-progress writes;
9. calls `FileHandle.sync()` and closes the journal;
10. synchronizes the containing directory on non-Windows platforms;
11. removes the lock, synchronizes the directory again so lock absence is durable, and returns a durable commit receipt.

The caller may authorize the event’s external effect only after receiving that receipt. A write, sync, close, directory-sync, or post-operation lock-cleanup ambiguity returns `commitUncertain`; the caller must reopen and replay under exclusive ownership before deciding what committed. The store does not silently retry an append.

An unterminated final byte fragment is treated as an uncommitted torn tail and may be truncated while locked. A malformed record that already ends in LF, or corruption before the tail, is permanent corruption and is never skipped or rewritten automatically.

Exclusive-create locking is cooperative rather than a defense against a malicious process running as the same account. A crash during the short locked storage operation can leave a lock file; automatic stale-lock breaking is deliberately excluded because PID reuse and clock-based leases can admit two writers. Explicit operator recovery tooling belongs to a later command surface.

`FileHandle.sync()` defines the package’s commit boundary using the guarantees exposed by Node and the selected local filesystem. The package does not claim protection against faulty hardware, dishonest storage firmware, unsupported network filesystems, or an administrator changing files concurrently.

## Consequences

### Positive

- Reducer state can be reconstructed without pi sessions or model context.
- Commit receipts create a clear append-before-effect boundary.
- Cooperative writers cannot commit the same sequence concurrently.
- Torn tails are recoverable without concealing permanent corruption.
- No production persistence dependency or native module is required.

### Negative

- Replay cost grows linearly until a future snapshot cache is introduced.
- A stale lock requires explicit operator inspection and removal.
- JSONL uses more space than a binary or database format.
- Filesystem durability is limited to the guarantees Node and the host-selected local filesystem expose.
- The lock does not protect against a malicious same-user process.

## Rejected alternatives

### Mutable snapshot with atomic rename

A snapshot can accelerate loading but cannot prove which authorization intent committed before an effect. It may later cache a validated journal prefix, but it cannot be authoritative.

### SQLite

SQLite would provide mature transactions and locking, but it adds a production dependency and native/runtime policy for a v0.1 workload bounded to small local journals. The package can add another `WorkflowJournalStore` implementation later without changing reducer semantics.

### Pi sessions or repository files

Pi sessions may contain sensitive conversation data and are not the workflow compatibility boundary. Repository-local authority would be easy to commit accidentally and would couple a run to a working tree. Both are rejected.

### Automatic stale-lock recovery

PID files and wall-clock leases cannot prove ownership after PID reuse, suspend, clock movement, or network-filesystem behavior. Silent lock breaking conflicts with the single-writer invariant.

## Validation

Tests cover durable append and reopen, reducer-equivalent replay, hash-derived filenames, private root requirements, lock contention, competing stores, symlink rejection, schema-valid oversized records, permanent newline-terminated corruption, torn-tail truncation and synchronization, contiguous sequence enforcement, and resume decisions. CI runs the same suite on Linux, macOS, and Windows.

## Follow-up decisions

- Issue #12 supplies canonical scope and evidence digests persisted by the journal.
- Issue #13 decides evidence satisfaction and retry policy, then emits explicit `stepReady` or `stepSettled` events.
- Issue #14 selects the user-facing state root and may add explicit stale-lock diagnostics.
- Snapshots, compaction, migration tooling, and retention policy are deferred until measured replay cost requires them.

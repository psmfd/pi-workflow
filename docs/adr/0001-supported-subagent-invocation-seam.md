# 1. Use an isolated pi JSON subprocess behind a package-owned invoker

Date: 2026-07-25

## Status

Accepted

## Context and problem statement

The workflow runtime must invoke specialized agents without asking the parent model to advance workflow state. The invocation boundary must support deterministic scheduling decisions, process isolation, cancellation, deadlines, typed failures, evidence capture, and later workflow-level recovery.

Pi 0.81.1 offers three programmatic surfaces:

- the in-process `createAgentSession()` SDK;
- the bidirectional subprocess RPC protocol;
- the one-shot JSON event stream used by pi's official subagent extension example.

The workflow package needs one-shot agent execution for v0.1. It does not need interactive steering or persistent child conversations. Pi deliberately leaves subagent design to extensions, so the workflow package must own its contract without exposing pi's internal event or message types to the deterministic runtime.

## Decision drivers

- Keep workflow scheduling and state transitions deterministic.
- Isolate each agent's context and process lifecycle.
- Use a documented pi interface rather than private runtime modules.
- Provide explicit cancellation, timeout, and failure outcomes.
- Permit deterministic tests without model or network access.
- Avoid promising exactly-once execution across process or host failure.
- Keep future pi compatibility changes inside one adapter.

## Considered options

1. Spawn `pi --mode json -p --no-session` behind a package-owned invoker.
2. Embed `createAgentSession()` directly in the workflow runtime.
3. Maintain a bidirectional `pi --mode rpc` child.
4. Invoke another extension's registered subagent tool.
5. Copy the existing subagent extension's implementation into the scheduler.

## Decision outcome

Chosen option: **one isolated, ephemeral pi JSON subprocess behind a package-owned `SubagentInvoker` port**.

The deterministic runtime owns invocation identity, attempt number, input digest, execution class, deadline, retry policy, and state transitions. The adapter owns executable resolution, argument construction, temporary instruction files, process lifecycle, strict LF-delimited JSON parsing, and projection of observed events into a terminal outcome.

The initial command contract is:

```text
pi --mode json -p --no-session \
  --no-context-files --no-skills --no-prompt-templates --no-extensions \
  [--extension <approved-absolute-path>]... \
  [--approve|--no-approve] [--model <provider/model>] \
  [--tools <allowlist>|--no-tools] \
  [--append-system-prompt <temporary-file>] "Task: <task>"
```

The process is started without a shell. Context files, skills, prompt templates, and automatic extension discovery are disabled so repository-authored or ambient resources cannot silently alter the child contract. Required extensions must be supplied as absolute host-approved paths, are canonicalized before dispatch, and are loaded explicitly. Project trust remains an explicit request field for the remaining project settings boundary. Tool capabilities are an explicit allowlist; an empty list becomes `--no-tools` rather than pi's default tools. Environment values are host-owned adapter configuration and cannot be supplied by workflow or agent input. The adapter forwards only runtime essentials, credentials associated with the selected provider, and additional keys explicitly approved by the host. Forwarded `PATH` entries are restricted to absolute host directories.

A successful invocation requires all of the following:

- the JSON stream begins with a pi session header;
- every non-empty record is a valid JSON object with a string `type`;
- the process exits with code zero;
- a terminal assistant `message_end` is observed;
- its stop reason is `stop`;
- it contains non-empty text.

Unknown, well-formed event types are accepted for forward compatibility. Raw stdout has per-record, aggregate-byte, and event-count limits. Malformed, unterminated, oversized, or contradictory streams fail closed and terminate the child. Intermediate assistant errors are accepted only when pi emits a matching automatic-retry lifecycle that settles successfully; an error followed by success without that lifecycle remains contradictory. Persistable evidence retains only bounded event metadata; prompt content, tool arguments, tool results, and temporary paths are excluded.

### Cancellation and deadlines

The invoker accepts an `AbortSignal` and an absolute persisted deadline with an explicit timezone. Already-cancelled or expired work is rejected before dispatch. Long deadlines are re-armed within the host timer limit rather than being clamped to an immediate timeout.

On POSIX, the child starts in a dedicated process group. Cancellation or deadline expiry signals that group with `SIGTERM`, then escalates to `SIGKILL` after a bounded grace period. On Windows, the adapter uses the absolute system `taskkill.exe` path with `/T /F` to terminate the process tree, requires a zero exit status, and then polls the target PID until it disappears. A nonzero tree-kill result remains unconfirmed even if the root PID vanished because descendants cannot then be proven terminated. A second bounded confirmation period prevents indefinite waiting. Deadline, grace, and confirmation timers remain referenced until the invocation settles because the returned promise depends on them; unreferenced lifecycle timers can let Node terminate with an unresolved invocation. A cancelled or timed-out outcome is returned only after tracked process-tree termination is confirmed; otherwise the result is `indeterminate`. This is process-tree lifecycle control, not an OS sandbox, and cannot constrain a descendant that deliberately escapes its process group or job ancestry.

The first observed control event wins: completion before cancellation remains completion; cancellation or timeout requested before process closure determines the terminal control outcome. Late child output cannot convert a cancelled or timed-out invocation into success.

### Resumability and retries

Child sessions are intentionally ephemeral and cannot be resumed. Workflow resumability belongs to the package-owned run journal planned in issue #11. A later runtime may replay a stored completed outcome for the same fenced invocation identity or dispatch a new attempt according to policy.

Exactly-once agent execution is not promised. The target guarantee is at most one active fenced attempt plus an explicit `indeterminate` state after uncertain termination. An indeterminate mutating invocation must not be retried automatically.

### Handoff and evidence

Assistant output is an untrusted claim, not verified evidence. The adapter records host-observed process status, only the bounded byte count of omitted stderr, projected pi event metadata, usage, model, stop reason, invocation identity, attempt, input digest, adapter version, and the command shape with task content and temporary paths redacted. Child-authored stderr and error-message contents are excluded from durable outcomes because no generic redactor can prove that credentials loaded from files or tools were removed. Schema validation and stronger evidence attestation belong to issue #13. A mutating invocation with a post-dispatch cancellation, timeout, protocol failure, process failure, or agent failure becomes non-retryable and `indeterminate` because side effects may already have occurred.

### Security boundary

A subprocess isolates context and lifecycle, not operating-system authority. The child retains the permissions and allowlisted host-controlled provider credential required to run pi. Workflow input cannot select an executable, inject shell syntax, or supply environment variables. Bare executable names are resolved only through absolute host `PATH` entries and canonicalized before the caller-selected cwd is used. Windows `.cmd` and `.bat` shims are rejected because they require shell interpretation; normal extension execution reuses pi's already-running JavaScript entrypoint, while custom hosts must configure an executable JavaScript entrypoint explicitly. Cwd, project trust, capabilities, models, and instructions remain policy inputs that callers must validate.

Temporary instruction files use owner-only permissions and are removed before the terminal outcome is returned. Cleanup failure is terminal and indeterminate rather than silently ignored.

## Consequences

### Positive

- The workflow runtime depends on a small stable interface instead of pi event types.
- Child context and process lifecycle are isolated.
- Tests can use a scripted fake pi executable without provider access.
- Pi command and event compatibility changes are localized.
- Cancellation, timeout, malformed output, and uncertainty are explicit.

### Negative

- Process startup has more overhead than an in-process SDK session.
- The adapter must maintain strict JSON stream and process-lifecycle handling.
- Process-group or process-tree lifecycle control does not provide a sandbox.
- Child-session continuation and interactive steering are unavailable.

## Rejected alternatives

### Direct `createAgentSession()` dependency

The SDK is supported and preferred for same-process Node integrations, but directly exposing `AgentSession` would couple deterministic scheduling to mutable model state, retries, compaction, resource discovery, and pi message types. A future in-process adapter may implement the same `SubagentInvoker` port if profiling justifies it.

### RPC subprocess

RPC is supported and provides explicit prompt, abort, steering, state, and session commands. Those capabilities are unnecessary for one-shot v0.1 execution and would add a second command/response correlation protocol. RPC can be reconsidered if workflows later require live steering or durable child conversations.

### Calling another extension's tool

Pi does not expose a supported extension API for one extension to execute another registered tool as a child-control plane. Tool composition through the parent model would also restore nondeterministic step advancement.

### Copying private or example internals into the scheduler

Pi's subagent example validates the subprocess approach, but combining discovery, spawning, parsing, presentation, and scheduling in one module would create unnecessary coupling. Only the documented command and event contracts are adopted.

## Validation

Acceptance tests use a scripted child process and cover command construction, empty tool allowlists, isolated resource loading, chunked LF and CRLF framing, unknown events, malformed or unterminated streams, aggregate stream bounds, missing terminal output, agent and process failures, spawn failure, pre-dispatch cancellation, absolute and long deadlines, mutating uncertainty, provider-scoped environment filtering, absolute `PATH` normalization, explicit extension loading, diagnostic omission, automatic-retry lifecycle handling, process-tree cancellation, and forced termination. Tests run offline and do not invoke a model provider.

## Follow-up decisions

- Issue #10 records the broader workflow runtime and compatibility contracts.
- Issue #11 implements the reducer and durable run journal.
- Issue #13 implements handoff schema validation, evidence validity, and retry policy.
- Issue #14 registers user-facing workflow commands and progress presentation.

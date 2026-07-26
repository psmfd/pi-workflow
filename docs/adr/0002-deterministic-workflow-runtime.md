# 2. Use versioned TypeScript contracts and an append-only event journal

Date: 2026-07-25

## Status

Accepted

## Context and problem statement

Prompt workflows such as `/review` rely on a model to interpret ordering, decide whether gates passed, and retain progress in conversation state. That makes transition legality, evidence freshness, retry behavior, and recovery after interruption nondeterministic.

ADR 0001 isolated one subagent invocation behind a typed `SubagentInvoker`. The package still needs a workflow-owned contract above that nondeterministic boundary. The contract must describe workflow topology, canonical run scope, transitions, persisted events, evidence references, retries, cancellation, and compatibility without binding the runtime to pi session internals.

## Decision drivers

- Make every state transition a pure and testable consequence of persisted input.
- Resume without resetting deadlines or silently repeating uncertain side effects.
- Reject incompatible or malformed persisted data before execution.
- Keep workflows authored as typed TypeScript rather than introducing a generic DSL.
- Keep pi process and event details behind ADR 0001's invocation adapter.
- Preserve existing `/review` behavior until an explicit compatibility wrapper is delivered.
- Permit future contract evolution without interpreting old records as a new shape.

## Considered options

1. Versioned TypeScript definitions, executable validation, a deterministic reducer, and an append-only event journal.
2. Declarative YAML workflow definitions interpreted at runtime.
3. Parent-model advancement with progress retained in conversation history.
4. Mutable snapshots written in place without a replayable journal.
5. Persisted pi sessions and pi event objects as workflow state.

## Decision outcome

Chosen option: **versioned TypeScript contracts reduced from an append-only event journal**.

A workflow is constructed in TypeScript as a `WorkflowDefinition`. Definitions contain stable step identifiers, explicit dependency edges, requested invocation capabilities, and bounded retry policy. They are data produced by typed code, not a YAML, shell, or prompt DSL. Trusted host policy resolves cwd, model, executable, extensions, credentials, capability grants, and the effective read-only or mutating classification at the execution boundary. Workflow-authored labels never grant authority or control uncertainty handling.

The public runtime contract version starts at `1`. Definitions and journal envelopes are size-bounded and validated before use. Serialized envelopes are bounded before JSON parsing; object width and diagnostics are bounded during validation. Unknown fields and unsupported versions fail closed. Step identifiers are unique, dependencies must exist, duplicate edges and cycles are invalid, timestamps are strict calendar-valid ISO-8601 values with explicit offsets, and retry policy cannot name `indeterminate` as an automatic outcome.

The v1 schema is published in [`src/runtime/contracts.ts`](../../src/runtime/contracts.ts), with zero-dependency executable validation in [`src/runtime/validation.ts`](../../src/runtime/validation.ts). The human-readable contract and examples are in [`docs/runtime-contracts.md`](../runtime-contracts.md).

### Deterministic state and transitions

The reducer planned in issue #11 will be a pure function of a previous state and one validated `WorkflowJournalEnvelope`. It must not read the clock, filesystem, Git, process state, environment, or model output. Nondeterministic observations enter through explicit events.

Run and step terminal states are monotonic. A terminal state cannot return to a running state. A running step may return to `ready` only when a new attempt is permitted by validated policy; the prior attempt remains settled and immutable. Failed dependencies make downstream steps `blocked` rather than silently skipping them.

Journal sequence numbers are positive and contiguous within a run. Event identifiers, run identifiers, step identifiers, invocation identifiers, and attempt numbers fence observations to their owner. Reducers reject stale or mismatched attempt outcomes.

### Write-ahead side-effect boundary

Events that authorize an external effect are persisted before that effect begins. In particular, `attemptPlanned` records the invocation identity, attempt number, input digest, absolute deadline, and host authorization before dispatch. `attemptStarted` records the dispatch boundary. `attemptSettled` records a minimized typed terminal outcome projected from `SubagentInvoker`; it excludes assistant output, child error messages, and raw adapter evidence.

An implementation may also persist derived snapshots for faster loading, but a snapshot is only a cache of a validated journal prefix. The journal remains authoritative, and snapshot metadata must name the last included sequence and contract version.

### Scope and evidence

`WorkflowRunScope` fixes repository root, base/head identity, scope kind, and canonical digest at run creation. Resume reuses that identity. Issue #12 supplies canonicalization and digest algorithms; this ADR fixes their persisted boundary.

Workflow evidence is referenced by stable identity, invocation attempt, input digest, and scope digest. Assistant prose is never sufficient proof of freshness. A scope or input change emits `evidenceInvalidated`; invalid evidence cannot satisfy a gate. Issue #13 supplies stronger evidence validation and attestation rules.

Adapter-specific evidence remains at the invocation boundary. The journal stores only package-owned outcome classifications, fenced `WorkflowEvidenceReference` values, and optional metadata for artifacts held in a size-bounded protected external store. `evidenceRecorded` is the only event that creates gate-eligible evidence, and `evidenceInvalidated` revokes it. The reducer does not persist assistant output, child-authored error text, raw pi events, or `AbortSignal`.

### Failure, cancellation, and timeout semantics

Expected child failures resolve through ADR 0001's typed outcomes. Workflow policy handles them as follows:

- `succeeded` may satisfy the step only after validated evidence is recorded and remains valid;
- `failed`, `cancelled`, or `timedOut` may create a new attempt only when policy permits and the attempt budget remains;
- `indeterminate` never retries automatically;
- an indeterminate mutating attempt requires manual resolution or run abort;
- exhausted attempts fail the step and block dependent steps;
- cancellation is journaled before active invocations are signalled;
- late output cannot reverse a cancellation or another terminal transition.

Timeout duration belongs to the definition, while the first dispatch calculation produces an absolute `deadlineAt`. That absolute deadline is journaled and reused after resume. Restarting a process cannot extend an existing attempt's time budget.

### Resume and recovery

Resume validates every journal envelope, checks contract compatibility, verifies contiguous sequence numbers, and replays from the initial `runCreated` event. Recovery then uses the last fenced attempt state:

| Last durable state | Recovery decision |
| --- | --- |
| Terminal outcome recorded | Replay the outcome; do not dispatch again |
| Planned but not started | Dispatch the same fenced attempt if its absolute deadline remains valid |
| Read-only attempt started without outcome | Journal `attemptRecoveryRequired`; resolve it before policy may create a new attempt |
| Mutating attempt started without outcome | Journal recovery requirement and await manual resolution; never retry automatically |
| Unsupported contract or invalid journal | Refuse resume without executing effects |

Exactly-once execution is not promised. The contract provides at most one active fenced attempt, durable intent before dispatch, replay of completed outcomes, and explicit uncertainty after an interrupted effect.

### Compatibility boundary

Existing `/review` remains owned by the legacy prompt workflow. This package does not intercept, rewrite, or automatically migrate it in v1. The constant `LEGACY_REVIEW_COMPATIBILITY` makes that boundary explicit.

Issue #17 will provide the compatibility wrapper and end-to-end acceptance tests. Until then, both systems may coexist, but a single invocation must be owned by only one of them. Existing prompts, output formatting, and review verdict aggregation are not changed by this ADR.

## Consequences

### Positive

- Workflow progression is replayable and independent of model interpretation.
- Persisted data has an explicit compatibility and validation boundary.
- Attempts, deadlines, evidence, and recovery decisions are fenced and auditable.
- TypeScript authors retain normal language composition without a second DSL.
- The reducer can be tested without pi, GitHub, a model, or the filesystem.

### Negative

- The package must maintain schemas and migrations as contracts evolve.
- Append-before-effect persistence adds latency and implementation complexity.
- Exactly-once side effects remain impossible after host or process failure.
- TypeScript workflow definitions are less convenient for non-developer authors than YAML.
- Manual resolution is required for uncertain mutating attempts.

## Rejected alternatives

### Generic YAML or shell DSL

A generic DSL would duplicate TypeScript's composition and validation facilities, require a parser and compatibility policy, and make arbitrary shell execution tempting. Initial workflows are package code and use exported TypeScript contracts.

### Parent-model advancement

A model may propose work and produce outputs, but it cannot own transition legality, persistence, retry authorization, or evidence freshness. Conversation state is not a durable workflow journal.

### Mutable snapshot only

In-place state cannot prove which intent was durable before a side effect or reconstruct why a transition occurred. Snapshots may accelerate replay but cannot replace the journal.

### Persisting pi sessions or raw events

Pi sessions are adapter state, may contain sensitive conversation content, and are not the workflow compatibility boundary. ADR 0001 projects pi observations into package-owned outcomes instead.

## Validation

Contract tests cover accepted and bounded definitions, unsupported versions, unknown fields, strict scope validation, duplicate and missing dependencies, iterative cycle detection, invalid automatic retries, strict absolute timestamps, minimized outcomes, protected artifact references, durable recovery events, fenced attempt identity, legal transitions, and terminal-state monotonicity. Issue #11 adds reducer replay and journal persistence tests; issues #12 and #13 add canonical identity and evidence-policy tests.

## Follow-up decisions

- Issue #11 implements the reducer and journal persistence behind these contracts.
- Issue #12 defines canonical scope and evidence identity algorithms.
- Issue #13 implements evidence validation and retry execution policy.
- Issue #14 registers workflow commands and progress presentation.
- Issue #17 implements the `/review` compatibility wrapper and migration tests.

Issue #28 aligned post-dispatch child-process errors with mutating uncertainty before runtime retry execution shipped.

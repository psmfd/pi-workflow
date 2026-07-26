# Workflow runtime contracts

The workflow runtime owns deterministic scheduling above the nondeterministic subagent invocation seam defined by [ADR 0001](adr/0001-supported-subagent-invocation-seam.md). [ADR 0002](adr/0002-deterministic-workflow-runtime.md) records the runtime decision.

## Contract boundary

Version 1 exports package-owned contracts from `@psmfd/pi-workflow`:

- `WorkflowDefinition` and `WorkflowStepDefinition` describe typed topology;
- `WorkflowRunScope` fixes the canonical work identity for a run;
- `WorkflowRunState` and `WorkflowStepState` describe reducer output;
- `WorkflowJournalEnvelope` and `WorkflowEvent` describe durable input;
- `WorkflowEvidenceReference` binds evidence to scope and attempt identity;
- `WorkflowRecoveryDecision` makes resume behavior explicit;
- `WORKFLOW_DEFINITION_SCHEMA` and `WORKFLOW_JOURNAL_ENVELOPE_SCHEMA` validate untrusted values;
- `isLegalRunTransition` and `isLegalStepTransition` publish transition invariants.

These contracts contain only persistable data. Clocks, `AbortSignal`, processes, Git queries, environment values, and pi event objects remain outside reducer state.

## Typed definition example

Workflows are TypeScript values. Version 1 does not define a YAML or shell representation.

```ts
import {
  WORKFLOW_DEFINITION_SCHEMA,
  WORKFLOW_RUNTIME_CONTRACT_VERSION,
  type WorkflowDefinition,
} from "@psmfd/pi-workflow";

const localReview = {
  contractVersion: WORKFLOW_RUNTIME_CONTRACT_VERSION,
  workflowId: "review.local",
  description: "Review a fixed local-change scope.",
  steps: [
    {
      stepId: "review",
      dependsOn: [],
      invocation: {
        agent: "code-review-expert",
        task: "Review the canonical scope and return a structured verdict.",
        requestedCapabilities: ["read", "git_read"],
        timeoutMs: 300_000,
      },
      retry: {
        maxAttempts: 2,
        automaticFor: ["failed", "timedOut"],
      },
    },
    {
      stepId: "summarize",
      dependsOn: ["review"],
      invocation: {
        agent: "docs-expert",
        task: "Summarize validated review evidence.",
        requestedCapabilities: ["read"],
      },
      retry: {
        maxAttempts: 1,
        automaticFor: [],
      },
    },
  ],
} as const satisfies WorkflowDefinition;

if (!WORKFLOW_DEFINITION_SCHEMA.is(localReview)) {
  throw new Error("invalid workflow definition");
}
```

Host policy—not the definition—selects the pi executable, cwd, model, provider credentials, extension paths, and approved realization of requested capabilities. A definition cannot expand its own authority.

## Definition validation

Validation is strict and side-effect free:

- `contractVersion` must be supported;
- unknown fields are rejected;
- workflows contain at least one step;
- workflow, step, agent, task, and capability identifiers are non-empty and bounded;
- workflows, object width, dependencies, capabilities, task text, and retry budgets have explicit size limits;
- step identifiers and capability entries are unique;
- dependencies reference existing steps and contain no duplicates or cycles;
- attempt counts and timeout durations are positive safe integers;
- automatic retry outcomes are limited to `failed`, `cancelled`, and `timedOut`;
- `indeterminate` can never be configured for automatic retry.

Call `.validate(value)` when diagnostics are needed or `.is(value)` for a type-narrowing check. Both fail closed for arbitrary unknown values, including throwing accessors and proxies. Persisted input must be validated before it is reduced or used to authorize an effect. Serialized journal input must enter through `parseWorkflowJournalEnvelopeJson`, which enforces `MAX_WORKFLOW_JOURNAL_ENVELOPE_BYTES` before parsing and then applies the strict schema.

## Run scope

A `WorkflowRunScope` is fixed when `runCreated` is persisted:

| Field | Meaning |
| --- | --- |
| `kind` | `localChanges` or `pullRequest` |
| `scopeId` | Stable identity for the canonical scope |
| `digest` | Digest covering the canonical scope input |
| `repositoryRoot` | Canonical repository root selected by host policy |
| `baseRevision` | Immutable base revision used by the run |
| `headRevision` | Immutable head revision when the scope has one |
| `pullRequestNumber` | Pull-request number when applicable |

Issue #12 defines canonicalization and digest algorithms. Resume uses the persisted scope and never silently substitutes the current working tree or a moved pull-request head. A changed scope creates a new run or explicitly invalidates prior evidence.

## Journal and transition semantics

Each journal line is a size-bounded `WorkflowJournalEnvelope` with a contract version, run identifier, positive contiguous sequence number, strict calendar-valid ISO-8601 timestamp with an explicit offset, and one event. Implementations append and durably commit authorization events before starting their corresponding effects.

The initial event is `runCreated`, which captures the validated definition, its digest, and scope. Typical execution then records:

1. `runStarted`;
2. `stepReady`;
3. `attemptPlanned` with fenced identity, input digest, absolute deadline, and host authorization;
4. `attemptStarted` immediately before dispatch;
5. `attemptSettled` with a minimized package-owned outcome containing no assistant output;
6. `evidenceRecorded` with fenced metadata and an optional protected artifact reference;
7. `runSettled` after all required steps reach a terminal result.

`attemptRecoveryRequired`, `attemptRecoveryResolved`, `evidenceInvalidated`, and `cancellationRequested` are explicit observations rather than hidden state mutations. Unknown event variants and unknown fields fail validation under contract version 1.

Run states may transition from `pending` to `running`, or directly to `cancelled`. A running run may become `succeeded`, `failed`, `cancelled`, or `indeterminate`. Those terminal states are immutable.

Step transitions are:

| From | Allowed destinations |
| --- | --- |
| `pending` | `ready`, `blocked`, `cancelled` |
| `ready` | `running`, `cancelled` |
| `running` | `ready`, `succeeded`, `failed`, `cancelled`, `indeterminate` |
| Any terminal state | None |

`running` to `ready` represents authorization of another fenced attempt after the previous attempt settled. It does not erase or reuse the previous attempt.

## Attempts, deadlines, and retries

An attempt is identified by `stepId`, a positive attempt number, `invocationId`, and `inputDigest`. Outcomes must match all fenced identity fields. A stale outcome is rejected even if it names the same step.

Definitions express a relative `timeoutMs`. Before dispatch, the runtime calculates one absolute `deadlineAt` and persists it in `attemptPlanned`. Resume uses that value; it does not grant a fresh timeout.

Requested capabilities are not grants. Trusted host policy produces `WorkflowInvocationAuthorization`, limits granted capabilities to the request, derives the effective `readOnly` or `mutating` classification, and records a policy digest. The reducer and dispatcher use only that host-owned classification when applying retry rules.

Automatic retry requires all of the following:

- the outcome is listed in `automaticFor`;
- `maxAttempts` is not exhausted;
- the latest attempt reached a validated terminal outcome;
- no required evidence from that attempt remains authoritative;
- the outcome is not `indeterminate`;
- host policy still approves the invocation.

ADR 0001 maps uncertain post-dispatch mutating failures to `indeterminate`, so they cannot enter the automatic retry path. Manual resolution must either establish the effect's result, invalidate it and authorize a new run, or abort.

## Evidence validity

A `WorkflowEvidenceReference` binds evidence to:

- one step and invocation attempt;
- the attempt input digest;
- the canonical scope digest;
- a stable evidence identifier;
- validity and optional invalidating journal sequence.

Model output is an untrusted claim. It is never embedded in the journal. Potentially sensitive content belongs in a size-bounded, access-controlled artifact store; the journal records only `WorkflowArtifactReference` metadata and digests. Output becomes gate-satisfying evidence only through the validation policy delivered by issue #13. Evidence from another scope, changed input, a superseded attempt, or an explicit invalidation cannot satisfy a transition.

## Failure and recovery matrix

| Condition | Required behavior |
| --- | --- |
| Definition or journal schema invalid | Fail closed before executing work |
| Contract version unsupported | Refuse resume and require migration or compatible runtime |
| Dependency fails | Mark dependent steps `blocked` |
| Retryable settled outcome | Create a new fenced attempt within policy |
| Attempt deadline already expired | Settle without dispatch; do not reset deadline |
| Terminal outcome already journaled | Replay it; never invoke again |
| Read-only attempt interrupted after start | Journal `attemptRecoveryRequired`; policy may resolve it as safe to retry |
| Mutating attempt interrupted after start | Journal recovery requirement and await explicit manual resolution |
| Scope or input changes | Invalidate affected evidence |
| Cancellation requested | Journal request, signal active work, ignore late success |

Snapshots may cache a validated journal prefix but never replace it. A snapshot names its contract version and last included sequence; replay continues from the next envelope.

## `/review` compatibility

Version 1 deliberately leaves the current `/review` prompt workflow unchanged:

| Surface | Before issue #17 | Issue #17 target |
| --- | --- | --- |
| Command ownership | Legacy prompt workflow | Explicit compatibility wrapper |
| Existing prompts | Unchanged | Adapted behind tested boundary |
| Verdict formatting | Unchanged | Preserved by end-to-end tests |
| Automatic migration | Disabled | Explicit opt-in policy |
| Active run ownership | Exactly one system | Exactly one system |

`LEGACY_REVIEW_COMPATIBILITY` exposes this boundary as package data. The runtime must not intercept or advance legacy runs before the compatibility wrapper exists.

## Downstream implementation ownership

This contract intentionally leaves behavior to ordered follow-up issues:

- #11: reducer and durable journal implementation;
- #12: canonical scope and evidence identity algorithms;
- #13: evidence validation and retry execution;
- #14: commands and progress presentation;
- #15 and #16: local and pull-request workflows;
- #17: `/review` compatibility wrapper and end-to-end acceptance tests.

/** Stable public contract for one workflow-owned subagent invocation. */
export const SUBAGENT_INVOCATION_CONTRACT_VERSION = 1;

export type InvocationContractVersion = typeof SUBAGENT_INVOCATION_CONTRACT_VERSION;

export interface InvocationRequest {
  readonly contractVersion: InvocationContractVersion;
  readonly invocationId: string;
  readonly attempt: number;
  readonly agent: string;
  readonly task: string;
  readonly cwd: string;
  readonly inputDigest: string;
  readonly execution: "readOnly" | "mutating";
  readonly capabilities: readonly string[];
  /** Absolute, host-approved extension entrypoints loaded after --no-extensions. */
  readonly extensionPaths?: readonly string[];
  readonly projectTrust: "approve" | "deny";
  readonly model?: string;
  readonly instructions?: string;
}

export interface InvocationControl {
  readonly signal?: AbortSignal;
  /** Absolute ISO-8601 deadline. Restarting a workflow must not reset it. */
  readonly deadlineAt?: string;
}

export interface InvocationUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly cost: number;
}

export interface InvocationEvidence {
  readonly contractVersion: InvocationContractVersion;
  readonly invocationId: string;
  readonly attempt: number;
  readonly inputDigest: string;
  readonly adapter: "pi-json-subprocess";
  readonly adapterVersion: 1;
  readonly command: readonly string[];
  readonly events: readonly Readonly<Record<string, unknown>>[];
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly usage: InvocationUsage;
  readonly model?: string;
  readonly stopReason?: string;
}

export type InvocationErrorCode =
  | "invalidRequest"
  | "spawnFailed"
  | "protocolError"
  | "agentFailed"
  | "processFailed"
  | "terminationUnconfirmed"
  | "executionUncertain"
  | "cleanupFailed";

export interface InvocationError {
  readonly code: InvocationErrorCode;
  readonly phase: "preflight" | "dispatch" | "execution" | "handoff" | "cleanup";
  readonly message: string;
  readonly retryable: boolean;
}

interface TerminalOutcomeBase {
  readonly invocationId: string;
  readonly attempt: number;
  readonly evidence: InvocationEvidence;
}

export type InvocationOutcome =
  | (TerminalOutcomeBase & {
      readonly status: "succeeded";
      readonly output: string;
    })
  | (TerminalOutcomeBase & {
      readonly status: "failed";
      readonly error: InvocationError;
    })
  | (TerminalOutcomeBase & {
      readonly status: "cancelled";
      readonly acknowledged: true;
    })
  | (TerminalOutcomeBase & {
      readonly status: "timedOut";
      readonly acknowledged: true;
    })
  | (TerminalOutcomeBase & {
      readonly status: "indeterminate";
      readonly error: InvocationError;
    });

/**
 * Nondeterministic child execution boundary consumed by the deterministic
 * workflow runtime. Expected operational failures resolve to typed outcomes.
 */
export interface SubagentInvoker {
  invoke(request: InvocationRequest, control?: InvocationControl): Promise<InvocationOutcome>;
}

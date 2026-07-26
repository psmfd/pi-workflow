import {
  spawn,
  type ChildProcessByStdio,
  type SpawnOptionsWithStdioTuple,
  type StdioNull,
  type StdioPipe,
} from "node:child_process";
import { constants, existsSync } from "node:fs";
import { access, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, isAbsolute, join, resolve, sep } from "node:path";
import type { Readable } from "node:stream";

import {
  SUBAGENT_INVOCATION_CONTRACT_VERSION,
  type InvocationControl,
  type InvocationError,
  type InvocationEvidence,
  type InvocationOutcome,
  type InvocationRequest,
  type InvocationUsage,
  type SubagentInvoker,
} from "./contracts.js";
import { StrictJsonlDecoder } from "./jsonl.js";

const DEFAULT_TERMINATION_GRACE_MS = 5_000;
const DEFAULT_TERMINATION_CONFIRMATION_MS = 10_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_STDERR_BYTES = 256 * 1024;
const PROCESS_ERROR_MESSAGE = "Child process reported an operational error";

const BASE_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SHELL",
  "COMSPEC",
  "SystemRoot",
  "WINDIR",
  "APPDATA",
  "LOCALAPPDATA",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "PI_CODING_AGENT_DIR",
  "PI_PACKAGE_DIR",
  "PI_OFFLINE",
  "PI_SKIP_VERSION_CHECK",
  "PI_TELEMETRY",
  "PI_CACHE_RETENTION",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
] as const;

const PROVIDER_ENVIRONMENT_KEYS = new Map<string, readonly string[]>([
  ["anthropic", ["ANTHROPIC_API_KEY"]],
  ["openai", ["OPENAI_API_KEY"]],
  ["google", ["GOOGLE_API_KEY", "GEMINI_API_KEY"]],
  ["azure-openai", ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT"]],
  [
    "bedrock",
    ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_REGION", "AWS_DEFAULT_REGION"],
  ],
]);

export interface PiCommand {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
}

export type RootProcessSpawner = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithStdioTuple<StdioNull, StdioPipe, StdioPipe>,
) => ChildProcessByStdio<null, Readable, Readable>;

export interface PiProcessInvokerOptions {
  readonly piCommand?: PiCommand;
  readonly terminationGraceMs?: number;
  readonly terminationConfirmationMs?: number;
  /** Host-owned root-process seam. Intended for deterministic lifecycle tests. */
  readonly rootProcessSpawner?: RootProcessSpawner;
  /** Source environment. Only the documented allowlist is forwarded. */
  readonly environment?: Readonly<NodeJS.ProcessEnv>;
  /** Additional host-approved environment keys for custom providers. */
  readonly allowedEnvironmentKeys?: readonly string[];
}

interface ProcessResult {
  readonly dispatched: boolean;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  readonly processError?: string;
  readonly termination: "cancelled" | "timedOut" | "protocolError" | undefined;
  readonly terminationConfirmed: boolean;
  readonly decoder: ReturnType<StrictJsonlDecoder["finish"]>;
  readonly stderr: string;
}

interface AssistantProjection {
  readonly output?: string;
  readonly model?: string;
  readonly stopReason?: string;
  readonly protocolError?: string;
  readonly usage: InvocationUsage;
}

function defaultPiCommand(): PiCommand {
  const currentScript = process.argv[1];
  if (
    currentScript !== undefined &&
    !currentScript.startsWith("/$bunfs/root/") &&
    // The candidate comes from Node's own process argv, not workflow input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    existsSync(currentScript)
  ) {
    return { command: process.execPath, prefixArgs: [resolve(currentScript)] };
  }

  const executable = basename(process.execPath).toLowerCase();
  if (!/^(?:node|bun)(?:\.exe)?$/.test(executable)) return { command: process.execPath };
  return { command: "pi" };
}

function invalidRequest(message: string): InvocationError {
  return { code: "invalidRequest", phase: "preflight", message, retryable: false };
}

function emptyUsage(): InvocationUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

function finiteNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function assistantProjection(events: readonly Readonly<Record<string, unknown>>[]): AssistantProjection {
  let output: string | undefined;
  let model: string | undefined;
  let stopReason: string | undefined;
  let protocolError: string | undefined;
  let sawTerminalStop = false;
  let unresolvedFailure = false;
  let retryAttempt: number | undefined;
  let retryProducedNonError = false;
  let failureCount = 0;
  let failureCountAtRetryStart = 0;
  let lastFailureWasError = false;
  let input = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let totalTokens = 0;
  let cost = 0;

  for (const event of events) {
    if (event["type"] === "auto_retry_start") {
      const attempt = event["attempt"];
      const expectedAttempt = retryAttempt === undefined ? 1 : retryAttempt + 1;
      if (
        !unresolvedFailure ||
        !lastFailureWasError ||
        sawTerminalStop ||
        failureCount <= failureCountAtRetryStart ||
        typeof attempt !== "number" ||
        !Number.isSafeInteger(attempt) ||
        attempt !== expectedAttempt
      ) {
        protocolError ??= "Invalid automatic-retry start event";
      } else {
        retryAttempt = attempt;
        retryProducedNonError = false;
        failureCountAtRetryStart = failureCount;
      }
      continue;
    }
    if (event["type"] === "auto_retry_end") {
      const attempt = event["attempt"];
      if (
        retryAttempt === undefined ||
        attempt !== retryAttempt ||
        typeof event["success"] !== "boolean" ||
        (event["success"] === true && !retryProducedNonError)
      ) {
        protocolError ??= "Automatic-retry end did not match the active attempt";
      } else {
        if (event["success"] === true) unresolvedFailure = false;
        retryAttempt = undefined;
        retryProducedNonError = false;
      }
      continue;
    }
    if (event["type"] !== "message_end") continue;
    const message = record(event["message"]);
    if (message?.["role"] !== "assistant") continue;

    if (sawTerminalStop) protocolError = "Assistant messages were observed after a terminal stop";
    const currentStopReason = message["stopReason"];
    if (retryAttempt !== undefined && currentStopReason !== "error") retryProducedNonError = true;
    if (currentStopReason === "stop") {
      if (unresolvedFailure && retryAttempt === undefined) {
        protocolError = "A successful assistant outcome followed an error without a retry lifecycle";
      }
      sawTerminalStop = true;
    }
    if (
      currentStopReason === "error" ||
      currentStopReason === "aborted" ||
      currentStopReason === "length"
    ) {
      unresolvedFailure = true;
      failureCount += 1;
      lastFailureWasError = currentStopReason === "error";
    }

    const content = Array.isArray(message["content"]) ? message["content"] : [];
    output = content
      .map((part: unknown) => record(part))
      .filter((part): part is Record<string, unknown> => part !== undefined)
      .filter((part) => part["type"] === "text" && typeof part["text"] === "string")
      .map((part) => part["text"] as string)
      .join("");

    if (typeof message["model"] === "string") model = message["model"];
    if (typeof message["stopReason"] === "string") stopReason = message["stopReason"];

    const usage = record(message["usage"]);
    if (usage !== undefined) {
      input += finiteNumber(usage["input"]);
      outputTokens += finiteNumber(usage["output"]);
      cacheRead += finiteNumber(usage["cacheRead"]);
      cacheWrite += finiteNumber(usage["cacheWrite"]);
      totalTokens += finiteNumber(usage["totalTokens"]);
      cost += finiteNumber(record(usage["cost"])?.["total"]);
    }
  }

  if (retryAttempt !== undefined) {
    protocolError ??= "The automatic-retry lifecycle ended with an active attempt";
  }
  if (sawTerminalStop && unresolvedFailure) {
    protocolError ??= "The assistant retry lifecycle did not settle successfully";
  }

  return {
    usage: { input, output: outputTokens, cacheRead, cacheWrite, totalTokens, cost },
    ...(output === undefined ? {} : { output }),
    ...(model === undefined ? {} : { model }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(protocolError === undefined ? {} : { protocolError }),
  };
}

function boundedText(value: string, maximumBytes: number, label: string): string {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maximumBytes) return value;
  return `[${label} truncated to last ${maximumBytes} bytes]\n${bytes.subarray(bytes.length - maximumBytes).toString("utf8")}`;
}

function isAbsoluteTimestamp(value: string): boolean {
  const hasZuluSuffix = value.endsWith("Z");
  const offsetStart = value.length - 6;
  const offsetSign = value.charAt(offsetStart);
  const hasNumericOffset =
    offsetStart > 0 &&
    (offsetSign === "+" || offsetSign === "-") &&
    value.charAt(value.length - 3) === ":" &&
    [...value.slice(offsetStart + 1, offsetStart + 3), ...value.slice(-2)].every(
      (character) => character >= "0" && character <= "9",
    );
  return value.includes("T") && (hasZuluSuffix || hasNumericOffset) && Number.isFinite(Date.parse(value));
}

function validateRequest(request: InvocationRequest, deadlineAt?: string): InvocationError | undefined {
  if (typeof request !== "object" || request === null) return invalidRequest("request must be an object");
  if (request.contractVersion !== SUBAGENT_INVOCATION_CONTRACT_VERSION) {
    return invalidRequest(`Unsupported invocation contract version: ${String(request.contractVersion)}`);
  }
  if (typeof request.invocationId !== "string" || request.invocationId.trim().length === 0) {
    return invalidRequest("invocationId is required");
  }
  if (!Number.isSafeInteger(request.attempt) || request.attempt < 1) {
    return invalidRequest("attempt must be a positive safe integer");
  }
  if (typeof request.agent !== "string" || request.agent.trim().length === 0) {
    return invalidRequest("agent is required");
  }
  if (typeof request.task !== "string" || request.task.trim().length === 0) {
    return invalidRequest("task is required");
  }
  if (typeof request.inputDigest !== "string" || request.inputDigest.trim().length === 0) {
    return invalidRequest("inputDigest is required");
  }
  if (typeof request.cwd !== "string" || request.cwd.trim().length === 0) {
    return invalidRequest("cwd is required");
  }
  if (request.execution !== "readOnly" && request.execution !== "mutating") {
    return invalidRequest("execution must be readOnly or mutating");
  }
  if (request.projectTrust !== "approve" && request.projectTrust !== "deny") {
    return invalidRequest("projectTrust must be approve or deny");
  }
  if (!Array.isArray(request.capabilities)) return invalidRequest("capabilities must be an array");
  if (
    request.capabilities.some(
      (name: unknown) => typeof name !== "string" || name.length === 0 || name.includes(","),
    )
  ) {
    return invalidRequest("capabilities must be non-empty tool names without commas");
  }
  if (new Set(request.capabilities).size !== request.capabilities.length) {
    return invalidRequest("capabilities must not contain duplicates");
  }
  if (
    request.extensionPaths !== undefined &&
    (!Array.isArray(request.extensionPaths) ||
      request.extensionPaths.some((path: unknown) => typeof path !== "string" || !isAbsolute(path)))
  ) {
    return invalidRequest("extensionPaths must contain only absolute paths");
  }
  if (request.model !== undefined && typeof request.model !== "string") {
    return invalidRequest("model must be a string");
  }
  if (request.instructions !== undefined && typeof request.instructions !== "string") {
    return invalidRequest("instructions must be a string");
  }
  if (
    deadlineAt !== undefined &&
    !isAbsoluteTimestamp(deadlineAt)
  ) {
    return invalidRequest("deadlineAt must be an absolute ISO-8601 timestamp with a timezone");
  }
  return undefined;
}

function validateControl(control: InvocationControl): InvocationError | undefined {
  if (typeof control !== "object" || control === null) return invalidRequest("control must be an object");
  if (control.deadlineAt !== undefined && typeof control.deadlineAt !== "string") {
    return invalidRequest("deadlineAt must be a string");
  }
  if (control.signal !== undefined && !(control.signal instanceof AbortSignal)) {
    return invalidRequest("signal must be an AbortSignal");
  }
  return undefined;
}

function requestIdentity(request: InvocationRequest): { invocationId: string; attempt: number } {
  return {
    invocationId:
      typeof request === "object" && request !== null && typeof request.invocationId === "string"
        ? request.invocationId
        : "<invalid>",
    attempt:
      typeof request === "object" && request !== null && Number.isSafeInteger(request.attempt)
        ? request.attempt
        : 0,
  };
}

function failure(request: InvocationRequest, evidence: InvocationEvidence, error: InvocationError): InvocationOutcome {
  return { status: "failed", ...requestIdentity(request), evidence, error };
}

function uncertainMutation(
  request: InvocationRequest,
  evidence: InvocationEvidence,
  error: InvocationError,
): InvocationOutcome {
  if (request.execution === "readOnly") return failure(request, evidence, error);
  return {
    status: "indeterminate",
    invocationId: request.invocationId,
    attempt: request.attempt,
    evidence,
    error: { ...error, retryable: false },
  };
}

function providerFromModel(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  return slash === -1 ? undefined : model.slice(0, slash).toLowerCase();
}

function childEnvironment(
  source: Readonly<NodeJS.ProcessEnv>,
  model: string | undefined,
  additionalKeys: readonly string[],
): NodeJS.ProcessEnv {
  const provider = providerFromModel(model);
  const allowed = new Set<string>([
    ...BASE_ENVIRONMENT_KEYS,
    ...(provider === undefined ? [] : (PROVIDER_ENVIRONMENT_KEYS.get(provider) ?? [])),
    ...additionalKeys,
  ]);
  return Object.fromEntries(
    [...allowed].flatMap((key) => {
      const value: unknown = Reflect.get(source, key);
      if (typeof value !== "string") return [];
      if (key !== "PATH") return [[key, value]];
      const absolutePath = value
        .split(delimiter)
        .map((entry) => entry.replace(/^"|"$/g, ""))
        .filter((entry) => isAbsolute(entry))
        .join(delimiter);
      return absolutePath.length === 0 ? [] : [[key, absolutePath]];
    }),
  );
}

function projectEvidenceEvents(
  events: readonly Readonly<Record<string, unknown>>[],
): readonly Readonly<Record<string, unknown>>[] {
  return events.map((event) => {
    const type = event["type"];
    const projected: Record<string, unknown> = { type };
    if (type === "session") {
      if (typeof event["version"] === "number") projected["version"] = event["version"];
      if (typeof event["id"] === "string") projected["id"] = event["id"];
      return projected;
    }
    if (type === "message_end") {
      const message = record(event["message"]);
      if (typeof message?.["role"] === "string") projected["role"] = message["role"];
      if (typeof message?.["model"] === "string") projected["model"] = message["model"];
      if (typeof message?.["stopReason"] === "string") projected["stopReason"] = message["stopReason"];
      return projected;
    }
    for (const key of ["toolCallId", "toolName", "isError"] as const) {
      const value: unknown = Reflect.get(event, key);
      if (typeof value === "string" || typeof value === "boolean") Reflect.set(projected, key, value);
    }
    return projected;
  });
}

function evidenceCommand(command: readonly string[]): readonly string[] {
  return command.map((argument, index) => {
    if (argument.startsWith("Task: ")) return "Task: <redacted>";
    if (index > 0 && command.at(index - 1) === "--append-system-prompt") {
      return "<temporary-instructions-file>";
    }
    if (index > 0 && command.at(index - 1) === "--extension") return "<approved-extension>";
    return argument;
  });
}

async function resolveExecutable(command: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  const hasPathSeparator = command.includes("/") || command.includes("\\") || command.includes(sep);
  if (isAbsolute(command) || hasPathSeparator) {
    // Host-owned executable path; resolve symlinks once before the caller-selected cwd is used.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const canonical = await realpath(resolve(command));
    await access(canonical, constants.X_OK);
    if (process.platform === "win32" && /\.(?:cmd|bat)$/i.test(canonical)) {
      throw new Error("Windows command shims are not directly executable; configure piCommand with pi's JavaScript entrypoint");
    }
    return canonical;
  }

  const pathValue = environment["PATH"];
  if (pathValue === undefined) throw new Error(`Cannot resolve executable without PATH: ${command}`);
  const suffixes = process.platform === "win32"
    ? (environment["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  for (const directory of pathValue.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    for (const suffix of suffixes) {
      if (process.platform === "win32" && /\.(?:CMD|BAT)$/i.test(suffix)) continue;
      const candidate = join(directory, process.platform === "win32" ? `${command}${suffix}` : command);
      try {
        await access(candidate, constants.X_OK);
        // Candidate is assembled only from absolute host PATH entries and a fixed command name.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return await realpath(candidate);
      } catch {
        // Continue searching absolute PATH entries.
      }
    }
  }
  throw new Error(`Executable not found in absolute PATH entries: ${command}`);
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted ?? false;
}

function scheduleAbsoluteDeadline(deadline: number, callback: () => void): () => void {
  let timer: NodeJS.Timeout | undefined;
  const arm = () => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      callback();
      return;
    }
    timer = setTimeout(arm, Math.min(remaining, MAX_TIMER_DELAY_MS));
  };
  arm();
  return () => {
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** Supported v0.1 adapter: one isolated, ephemeral pi JSON-mode subprocess. */
export class PiProcessInvoker implements SubagentInvoker {
  readonly #piCommand: PiCommand;
  readonly #terminationGraceMs: number;
  readonly #terminationConfirmationMs: number;
  readonly #rootProcessSpawner: RootProcessSpawner;
  readonly #environmentSource: Readonly<NodeJS.ProcessEnv>;
  readonly #allowedEnvironmentKeys: readonly string[];

  constructor(options: PiProcessInvokerOptions = {}) {
    this.#piCommand = options.piCommand ?? defaultPiCommand();
    this.#terminationGraceMs = options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;
    this.#terminationConfirmationMs =
      options.terminationConfirmationMs ?? DEFAULT_TERMINATION_CONFIRMATION_MS;
    this.#rootProcessSpawner = options.rootProcessSpawner ?? spawn;
    this.#environmentSource = options.environment ?? process.env;
    this.#allowedEnvironmentKeys = options.allowedEnvironmentKeys ?? [];
  }

  async invoke(request: InvocationRequest, control: InvocationControl = {}): Promise<InvocationOutcome> {
    const controlError = validateControl(control);
    const deadlineAt = controlError === undefined ? control.deadlineAt : undefined;
    const validationError = validateRequest(request, deadlineAt) ?? controlError;
    const placeholderCommand = [this.#piCommand.command, ...(this.#piCommand.prefixArgs ?? [])];
    if (validationError !== undefined) {
      return failure(request, this.#emptyEvidence(request, placeholderCommand), validationError);
    }

    if (signalIsAborted(control.signal)) {
      return {
        status: "cancelled",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence: this.#emptyEvidence(request, placeholderCommand),
        acknowledged: true,
      };
    }
    if (control.deadlineAt !== undefined && Date.parse(control.deadlineAt) <= Date.now()) {
      return {
        status: "timedOut",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence: this.#emptyEvidence(request, placeholderCommand),
        acknowledged: true,
      };
    }

    let canonicalCwd: string;
    try {
      // The caller-selected cwd is canonicalized before it reaches spawn.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      canonicalCwd = await realpath(resolve(request.cwd));
      await access(canonicalCwd);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        request,
        this.#emptyEvidence(request, placeholderCommand),
        invalidRequest(`cwd is not accessible: ${message}`),
      );
    }

    const environment = childEnvironment(
      this.#environmentSource,
      request.model,
      this.#allowedEnvironmentKeys,
    );
    let executable: string;
    try {
      executable = await resolveExecutable(this.#piCommand.command, environment);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(request, this.#emptyEvidence(request, placeholderCommand), {
        code: "spawnFailed",
        phase: "dispatch",
        message,
        retryable: true,
      });
    }

    const extensionPaths: string[] = [];
    try {
      for (const extensionPath of request.extensionPaths ?? []) {
        // Host-approved extension path is canonicalized before the child starts.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const canonicalExtension = await realpath(extensionPath);
        await access(canonicalExtension);
        extensionPaths.push(canonicalExtension);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      return failure(
        request,
        this.#emptyEvidence(request, placeholderCommand),
        invalidRequest(`extension path is not accessible: ${message}`),
      );
    }

    let instructionDirectory: string | undefined;
    let cleanupError: string | undefined;
    let args: string[] = [];
    let processResult: ProcessResult;

    try {
      args = [
        ...(this.#piCommand.prefixArgs ?? []),
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--no-context-files",
        "--no-skills",
        "--no-prompt-templates",
        "--no-extensions",
        request.projectTrust === "approve" ? "--approve" : "--no-approve",
      ];
      for (const extensionPath of extensionPaths) args.push("--extension", extensionPath);
      if (request.model !== undefined) args.push("--model", request.model);
      if (request.capabilities.length > 0) args.push("--tools", request.capabilities.join(","));
      else args.push("--no-tools");
      if (request.instructions !== undefined && request.instructions.trim().length > 0) {
        instructionDirectory = await mkdtemp(join(tmpdir(), "pi-workflow-invocation-"));
        const instructionPath = join(instructionDirectory, "instructions.md");
        // The destination is inside the adapter-created private temp directory.
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        await writeFile(instructionPath, request.instructions, { encoding: "utf8", mode: 0o600 });
        args.push("--append-system-prompt", instructionPath);
      }
      args.push(`Task: ${request.task}`);
      if (signalIsAborted(control.signal)) {
        processResult = this.#preDispatchResult("cancelled");
      } else if (control.deadlineAt !== undefined && Date.parse(control.deadlineAt) <= Date.now()) {
        processResult = this.#preDispatchResult("timedOut");
      } else {
        processResult = await this.#runProcess(executable, canonicalCwd, args, environment, control);
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      processResult = {
        dispatched: false,
        exitCode: null,
        exitSignal: null,
        processError: message,
        termination: undefined,
        terminationConfirmed: true,
        decoder: { events: [] },
        stderr: "",
      };
    } finally {
      if (instructionDirectory !== undefined) {
        try {
          await rm(instructionDirectory, { recursive: true, force: true });
        } catch (error: unknown) {
          cleanupError = error instanceof Error ? error.message : String(error);
        }
      }
    }

    const command = [executable, ...args];
    const projection = assistantProjection(processResult.decoder.events);
    const evidence = this.#evidence(request, command, processResult, projection);

    if (cleanupError !== undefined) {
      return {
        status: "indeterminate",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence,
        error: {
          code: "cleanupFailed",
          phase: "cleanup",
          message: `Failed to remove temporary instructions: ${cleanupError}`,
          retryable: false,
        },
      };
    }
    if (!processResult.terminationConfirmed) {
      return {
        status: "indeterminate",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence,
        error: {
          code: "terminationUnconfirmed",
          phase: "cleanup",
          message: "The child process group did not confirm termination within the bounded wait",
          retryable: false,
        },
      };
    }
    if (processResult.termination === "cancelled") {
      if (processResult.dispatched && request.execution === "mutating") {
        return {
          status: "indeterminate",
          invocationId: request.invocationId,
          attempt: request.attempt,
          evidence,
          error: {
            code: "executionUncertain",
            phase: "execution",
            message: "Mutating invocation was cancelled after dispatch; side effects require reconciliation",
            retryable: false,
          },
        };
      }
      return {
        status: "cancelled",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence,
        acknowledged: true,
      };
    }
    if (processResult.termination === "timedOut") {
      if (processResult.dispatched && request.execution === "mutating") {
        return {
          status: "indeterminate",
          invocationId: request.invocationId,
          attempt: request.attempt,
          evidence,
          error: {
            code: "executionUncertain",
            phase: "execution",
            message: "Mutating invocation timed out after dispatch; side effects require reconciliation",
            retryable: false,
          },
        };
      }
      return {
        status: "timedOut",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence,
        acknowledged: true,
      };
    }
    if (processResult.processError !== undefined) {
      if (!processResult.dispatched) {
        return failure(request, evidence, {
          code: "spawnFailed",
          phase: "dispatch",
          message: processResult.processError,
          retryable: true,
        });
      }
      return uncertainMutation(request, evidence, {
        code: "processFailed",
        phase: "execution",
        message: processResult.processError,
        retryable: true,
      });
    }
    if (processResult.decoder.error !== undefined) {
      return uncertainMutation(request, evidence, {
        code: "protocolError",
        phase: "handoff",
        message: processResult.decoder.error,
        retryable: true,
      });
    }
    if (processResult.exitCode === null) {
      return {
        status: "indeterminate",
        invocationId: request.invocationId,
        attempt: request.attempt,
        evidence,
        error: {
          code: "terminationUnconfirmed",
          phase: "execution",
          message: `Child terminated without an exit code${processResult.exitSignal === null ? "" : ` (${processResult.exitSignal})`}`,
          retryable: request.execution === "readOnly",
        },
      };
    }
    if (processResult.decoder.events[0]?.["type"] !== "session") {
      return uncertainMutation(request, evidence, {
        code: "protocolError",
        phase: "handoff",
        message: "pi JSON stream did not begin with a session header",
        retryable: true,
      });
    }
    if (processResult.exitCode !== 0) {
      return uncertainMutation(request, evidence, {
        code: "processFailed",
        phase: "execution",
        message: `pi exited with code ${processResult.exitCode}`,
        retryable: request.execution === "readOnly",
      });
    }
    if (projection.protocolError !== undefined) {
      return uncertainMutation(request, evidence, {
        code: "protocolError",
        phase: "handoff",
        message: projection.protocolError,
        retryable: request.execution === "readOnly",
      });
    }
    if (projection.stopReason !== "stop") {
      return uncertainMutation(request, evidence, {
        code: projection.stopReason === undefined ? "protocolError" : "agentFailed",
        phase: "handoff",
        message:
          projection.stopReason === undefined
            ? "No terminal assistant stop reason was observed"
            : `Agent stopped with reason: ${projection.stopReason}`,
        retryable: projection.stopReason === "error" && request.execution === "readOnly",
      });
    }
    if (projection.output === undefined || projection.output.trim().length === 0) {
      return uncertainMutation(request, evidence, {
        code: "protocolError",
        phase: "handoff",
        message: "No terminal assistant text was observed",
        retryable: true,
      });
    }

    return {
      status: "succeeded",
      invocationId: request.invocationId,
      attempt: request.attempt,
      evidence,
      output: projection.output,
    };
  }

  async #runProcess(
    executable: string,
    cwd: string,
    args: readonly string[],
    environment: Readonly<NodeJS.ProcessEnv>,
    control: InvocationControl,
  ): Promise<ProcessResult> {
    if (signalIsAborted(control.signal)) return this.#preDispatchResult("cancelled");
    if (control.deadlineAt !== undefined && Date.parse(control.deadlineAt) <= Date.now()) {
      return this.#preDispatchResult("timedOut");
    }

    const decoder = new StrictJsonlDecoder();
    let stderr = "";
    let processError: string | undefined;
    let termination: "cancelled" | "timedOut" | "protocolError" | undefined;
    let terminationConfirmed = true;
    let graceTimer: NodeJS.Timeout | undefined;
    let confirmationTimer: NodeJS.Timeout | undefined;
    let groupPollTimer: NodeJS.Timeout | undefined;
    let cancelDeadline = () => {};
    let settleExit: ((value: { code: number | null; signal: NodeJS.Signals | null }) => void) | undefined;

    const child = this.#rootProcessSpawner(executable, args, {
      cwd,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...environment },
    });

    let dispatched = false;
    let closed = false;
    let observedExit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let forceStarted = false;
    let forceCompleted = false;

    const signalTree = (signal: NodeJS.Signals) => {
      if (child.pid === undefined) return false;
      if (process.platform === "win32") return child.kill(signal);
      try {
        process.kill(-child.pid, signal);
        return true;
      } catch {
        return child.kill(signal);
      }
    };

    const startConfirmationTimer = () => {
      confirmationTimer = setTimeout(() => {
        terminationConfirmed = false;
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        settleExit?.({ code: null, signal: null });
      }, this.#terminationConfirmationMs);
    };

    const completeForce = (confirmed: boolean) => {
      if (forceCompleted || !terminationConfirmed) return;
      forceCompleted = true;
      if (!confirmed) terminationConfirmed = false;
      if (observedExit !== undefined) settleExit?.(observedExit);
    };

    const forceTree = () => {
      if (forceStarted) return;
      forceStarted = true;
      startConfirmationTimer();
      if (child.pid === undefined) {
        completeForce(false);
        return;
      }
      if (process.platform === "win32") {
        const systemRoot: unknown = Reflect.get(environment, "SystemRoot");
        if (typeof systemRoot !== "string" || !isAbsolute(systemRoot)) {
          child.kill("SIGKILL");
          completeForce(false);
          return;
        }
        const taskkill = join(systemRoot, "System32", "taskkill.exe");
        let killerFailed = false;
        const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], {
          shell: false,
          stdio: "ignore",
          windowsHide: true,
          env: { ...environment },
        });
        killer.once("error", () => {
          killerFailed = true;
          child.kill("SIGKILL");
          completeForce(false);
        });
        killer.once("close", (code) => {
          if (killerFailed || !terminationConfirmed) return;
          if (code !== 0) {
            completeForce(false);
            return;
          }
          const verifyRootExited = () => {
            if (!terminationConfirmed) return;
            let exists = false;
            try {
              process.kill(child.pid as number, 0);
              exists = true;
            } catch (error: unknown) {
              exists = record(error)?.["code"] !== "ESRCH";
            }
            if (!exists) {
              completeForce(true);
              return;
            }
            groupPollTimer = setTimeout(verifyRootExited, 10);
          };
          verifyRootExited();
        });
        return;
      }

      const processGroupId = -child.pid;
      signalTree("SIGKILL");
      const verifyGroupExited = () => {
        if (!terminationConfirmed) return;
        let exists = false;
        try {
          process.kill(processGroupId, 0);
          exists = true;
        } catch (error: unknown) {
          exists = record(error)?.["code"] !== "ESRCH";
        }
        if (!exists) {
          completeForce(true);
          return;
        }
        groupPollTimer = setTimeout(verifyGroupExited, 10);
      };
      verifyGroupExited();
    };

    const terminate = (reason: "cancelled" | "timedOut" | "protocolError") => {
      if (
        termination !== undefined ||
        processError !== undefined ||
        closed ||
        child.exitCode !== null ||
        child.signalCode !== null
      ) return;
      termination = reason;
      if (process.platform === "win32" || reason === "protocolError" || !signalTree("SIGTERM")) {
        forceTree();
        return;
      }
      graceTimer = setTimeout(forceTree, this.#terminationGraceMs);
    };

    child.once("spawn", () => {
      dispatched = true;
    });
    child.stdout.on("data", (chunk: Buffer) => {
      decoder.push(chunk);
      if (decoder.error !== undefined) terminate("protocolError");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = boundedText(stderr + chunk.toString("utf8"), MAX_STDERR_BYTES, "stderr");
    });
    child.on("error", () => {
      if (processError !== undefined || termination !== undefined || closed) return;
      processError = PROCESS_ERROR_MESSAGE;
      if (dispatched) {
        forceTree();
        return;
      }
      child.stdout.destroy();
      child.stderr.destroy();
      settleExit?.({ code: null, signal: null });
    });

    const abortListener = () => terminate("cancelled");
    control.signal?.addEventListener("abort", abortListener, { once: true });
    if (signalIsAborted(control.signal)) terminate("cancelled");
    if (control.deadlineAt !== undefined) {
      cancelDeadline = scheduleAbsoluteDeadline(Date.parse(control.deadlineAt), () => terminate("timedOut"));
    }

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      let settled = false;
      settleExit = (value) => {
        if (settled) return;
        settled = true;
        resolveExit(value);
      };
      child.once("close", (code, signal) => {
        closed = true;
        observedExit = { code, signal };
        if ((termination === undefined && processError === undefined) || forceCompleted) {
          settleExit?.(observedExit);
        }
      });
    });

    control.signal?.removeEventListener("abort", abortListener);
    cancelDeadline();
    if (graceTimer !== undefined) clearTimeout(graceTimer);
    if (confirmationTimer !== undefined) clearTimeout(confirmationTimer);
    if (groupPollTimer !== undefined) clearTimeout(groupPollTimer);

    return {
      dispatched,
      exitCode: exit.code,
      exitSignal: exit.signal,
      termination,
      terminationConfirmed,
      decoder: decoder.finish(),
      stderr,
      ...(processError === undefined ? {} : { processError }),
    };
  }

  #preDispatchResult(reason: "cancelled" | "timedOut"): ProcessResult {
    return {
      dispatched: false,
      exitCode: null,
      exitSignal: null,
      termination: reason,
      terminationConfirmed: true,
      decoder: { events: [] },
      stderr: "",
    };
  }

  #emptyEvidence(request: InvocationRequest, command: readonly string[]): InvocationEvidence {
    return {
      contractVersion: SUBAGENT_INVOCATION_CONTRACT_VERSION,
      ...requestIdentity(request),
      inputDigest:
        typeof request === "object" && request !== null && typeof request.inputDigest === "string"
          ? request.inputDigest
          : "<invalid>",
      adapter: "pi-json-subprocess",
      adapterVersion: 1,
      command: evidenceCommand(command),
      events: [],
      stderr: "",
      exitCode: null,
      exitSignal: null,
      usage: emptyUsage(),
    };
  }

  #evidence(
    request: InvocationRequest,
    command: readonly string[],
    processResult: ProcessResult,
    projection: AssistantProjection,
  ): InvocationEvidence {
    return {
      contractVersion: SUBAGENT_INVOCATION_CONTRACT_VERSION,
      invocationId: request.invocationId,
      attempt: request.attempt,
      inputDigest: request.inputDigest,
      adapter: "pi-json-subprocess",
      adapterVersion: 1,
      command: evidenceCommand(command),
      events: projectEvidenceEvents(processResult.decoder.events),
      stderr:
        processResult.stderr.length === 0
          ? ""
          : `[child stderr omitted: ${Buffer.byteLength(processResult.stderr, "utf8")} bounded bytes observed]`,
      exitCode: processResult.exitCode,
      exitSignal: processResult.exitSignal,
      usage: projection.usage,
      ...(projection.model === undefined ? {} : { model: projection.model }),
      ...(projection.stopReason === undefined ? {} : { stopReason: projection.stopReason }),
    };
  }
}

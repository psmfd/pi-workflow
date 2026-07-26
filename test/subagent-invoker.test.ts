import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  PiProcessInvoker,
  SUBAGENT_INVOCATION_CONTRACT_VERSION,
  type InvocationRequest,
  type RootProcessSpawner,
} from "../src/index.js";
import { StrictJsonlDecoder } from "../src/subagent/jsonl.js";

const fixture = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function request(task: string, overrides: Partial<InvocationRequest> = {}): InvocationRequest {
  return {
    contractVersion: SUBAGENT_INVOCATION_CONTRACT_VERSION,
    invocationId: `run/node/${task}/1`,
    attempt: 1,
    agent: "reviewer",
    task,
    cwd: process.cwd(),
    inputDigest: "sha256:test-input",
    execution: "readOnly",
    capabilities: ["read", "grep"],
    projectTrust: "deny",
    ...overrides,
  };
}

function invoker(
  options: {
    terminationGraceMs?: number;
    terminationConfirmationMs?: number;
    rootProcessSpawner?: RootProcessSpawner;
  } = {},
): PiProcessInvoker {
  return new PiProcessInvoker({
    piCommand: { command: process.execPath, prefixArgs: [fixture] },
    environment: {
      PATH: process.env["PATH"],
      SystemRoot: process.env["SystemRoot"],
    },
    ...options,
  });
}

function preSpawnErrorSpawner(): RootProcessSpawner {
  return (_command, _args, options) =>
    spawn(join(tmpdir(), "pi-workflow-injected-command-does-not-exist"), [], options);
}

function errorAfterSpawnSpawner(options: {
  beforeError?: () => void;
  afterError?: () => void;
  delayMs?: number;
} = {}): RootProcessSpawner {
  return (command, args, spawnOptions) => {
    const child = spawn(command, args, spawnOptions);
    child.once("spawn", () => {
      setTimeout(() => {
        options.beforeError?.();
        const credentialPrefix = ["Bear", "er"].join("");
        child.emit("error", new Error(`${credentialPrefix} must-not-survive`));
        options.afterError?.();
      }, options.delayMs ?? 0);
    });
    return child;
  };
}

function errorAfterCloseSpawner(afterClose: () => void): RootProcessSpawner {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    child.once("close", () => {
      queueMicrotask(() => {
        child.emit("error", new Error("injected late process error"));
        afterClose();
      });
    });
    return child;
  };
}

function errorAfterMarkerSpawner(marker: string): RootProcessSpawner {
  return (command, args, options) => {
    const child = spawn(command, args, options);
    child.once("spawn", () => {
      void (async () => {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          try {
            await access(marker);
            child.emit("error", new Error("injected process error after descendant start"));
            return;
          } catch {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
          }
        }
        child.emit("error", new Error("injected process error before descendant start"));
      })();
    });
    return child;
  };
}

void test("invokes the supported ephemeral pi JSON command and captures evidence", async () => {
  const outcome = await invoker().invoke(
    request("chunked", {
      model: "fake/model",
      instructions: "Return a structured review.",
    }),
  );

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.equal(outcome.output, "completed");
  assert.equal(outcome.evidence.model, "fake/model");
  assert.equal(outcome.evidence.stopReason, "stop");
  assert.deepEqual(outcome.evidence.usage, {
    input: 10,
    output: 4,
    cacheRead: 2,
    cacheWrite: 1,
    totalTokens: 17,
    cost: 0.25,
  });

  const command = outcome.evidence.command;
  assert.deepEqual(command.slice(0, 11), [
    process.execPath,
    fixture,
    "--mode",
    "json",
    "-p",
    "--no-session",
    "--no-context-files",
    "--no-skills",
    "--no-prompt-templates",
    "--no-extensions",
    "--no-approve",
  ]);
  assert.equal(command.includes("--tools"), true);
  assert.equal(command.includes("read,grep"), true);
  assert.equal(command.includes("--model"), true);
  assert.equal(command.includes("Task: <redacted>"), true);
  assert.equal(command.includes("--session"), false);

  const instructionFlag = command.indexOf("--append-system-prompt");
  assert.notEqual(instructionFlag, -1);
  assert.equal(command[instructionFlag + 1], "<temporary-instructions-file>");
});

void test("accepts CRLF framing and preserves unknown well-formed events", async () => {
  const crlf = await invoker().invoke(request("crlf"));
  assert.equal(crlf.status, "succeeded");

  const unknown = await invoker().invoke(request("unknown-event"));
  assert.equal(unknown.status, "succeeded");
  assert.equal(unknown.evidence.events.some((event) => event["type"] === "future_event"), true);
});

void test("fails closed on malformed or incomplete protocol streams", async (context) => {
  for (const [scenario, expected] of [
    ["malformed", "protocolError"],
    ["malformed-secret", "protocolError"],
    ["unterminated", "protocolError"],
    ["no-header", "protocolError"],
    ["no-output", "protocolError"],
    ["agent-error", "agentFailed"],
    ["contradictory", "protocolError"],
    ["retry-mismatch", "protocolError"],
    ["retry-dangling", "protocolError"],
    ["retry-skipped-attempt", "protocolError"],
    ["retry-consecutive-start", "protocolError"],
  ] as const) {
    await context.test(scenario, async () => {
      const outcome = await invoker().invoke(request(scenario));
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.equal(outcome.error.code, expected);
    });
  }

  const decoder = new StrictJsonlDecoder();
  decoder.push(Buffer.from('{"type":"event","secret":"must-not-survive",}\n'));
  const decoderResult = decoder.finish();
  assert.equal(decoderResult.error, "Invalid JSONL record");
  assert.doesNotMatch(decoderResult.error ?? "", /must-not-survive/);
});

void test("classifies nonzero exit and omits bounded stderr contents", async () => {
  const outcome = await invoker().invoke(request("nonzero"));
  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.error.code, "processFailed");
  assert.equal(outcome.error.retryable, true);
  assert.doesNotMatch(outcome.evidence.stderr, /child failure/);
  assert.match(outcome.evidence.stderr, /stderr omitted/);
  assert.equal(outcome.evidence.exitCode, 7);

  const large = await invoker().invoke(request("large-stderr"));
  assert.equal(large.status, "failed");
  assert.ok(Buffer.byteLength(large.evidence.stderr) < 256);
});

void test("classifies spawn failures without throwing", async () => {
  const outcome = await new PiProcessInvoker({
    piCommand: { command: join(tmpdir(), "pi-workflow-command-does-not-exist") },
  }).invoke(request("success"));

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.equal(outcome.error.code, "spawnFailed");
});

void test("keeps injected pre-spawn process errors retryable for mutating work", async () => {
  const outcome = await invoker({ rootProcessSpawner: preSpawnErrorSpawner() }).invoke(
    request("success", { execution: "mutating" }),
  );

  assert.equal(outcome.status, "failed");
  if (outcome.status !== "failed") return;
  assert.equal(outcome.error.code, "spawnFailed");
  assert.equal(outcome.error.phase, "dispatch");
  assert.equal(outcome.error.retryable, true);
});

void test("classifies post-dispatch process errors by execution class", async (context) => {
  for (const [execution, expectedStatus, expectedRetryable] of [
    ["readOnly", "failed", true],
    ["mutating", "indeterminate", false],
  ] as const) {
    await context.test(execution, async () => {
      const outcome = await invoker({ rootProcessSpawner: errorAfterSpawnSpawner() }).invoke(
        request("hang", { execution }),
      );
      assert.equal(outcome.status, expectedStatus);
      if (outcome.status !== "failed" && outcome.status !== "indeterminate") return;
      assert.equal(outcome.error.code, "processFailed");
      assert.equal(outcome.error.phase, "execution");
      assert.equal(outcome.error.retryable, expectedRetryable);
      assert.doesNotMatch(outcome.error.message, /must-not-survive/);
      assert.doesNotMatch(JSON.stringify(outcome.evidence), /must-not-survive/);
    });
  }
});

void test("preserves cancellation precedence over a later process error", async () => {
  const controller = new AbortController();
  const outcome = await invoker({
    terminationGraceMs: 20,
    rootProcessSpawner: errorAfterSpawnSpawner({ beforeError: () => controller.abort() }),
  }).invoke(request("ignore-term", { execution: "mutating" }), { signal: controller.signal });

  assert.equal(outcome.status, "indeterminate");
  if (outcome.status !== "indeterminate") return;
  assert.equal(outcome.error.code, "executionUncertain");
  assert.equal(outcome.error.retryable, false);
});

void test("preserves timeout precedence over a later process error", async () => {
  const deadlineAt = new Date(Date.now() + 100).toISOString();
  const outcome = await invoker({
    terminationGraceMs: 100,
    rootProcessSpawner: errorAfterSpawnSpawner({ delayMs: 110 }),
  }).invoke(request("ignore-term", { execution: "mutating" }), { deadlineAt });

  assert.equal(outcome.status, "indeterminate");
  if (outcome.status !== "indeterminate") return;
  assert.equal(outcome.error.code, "executionUncertain");
  assert.equal(outcome.error.retryable, false);
});

void test("keeps a process error authoritative over later cancellation", async () => {
  const controller = new AbortController();
  const outcome = await invoker({
    rootProcessSpawner: errorAfterSpawnSpawner({ afterError: () => controller.abort() }),
  }).invoke(request("hang", { execution: "mutating" }), { signal: controller.signal });

  assert.equal(outcome.status, "indeterminate");
  if (outcome.status !== "indeterminate") return;
  assert.equal(outcome.error.code, "processFailed");
  assert.equal(outcome.error.retryable, false);
});

void test("ignores process errors and cancellation observed after close", async () => {
  const controller = new AbortController();
  const outcome = await invoker({
    rootProcessSpawner: errorAfterCloseSpawner(() => controller.abort()),
  }).invoke(request("success"), { signal: controller.signal });

  assert.equal(outcome.status, "succeeded");
});

void test("confirms descendant termination before returning a process error", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-process-error-tree-"));
  const ready = join(directory, "ready");
  const survivor = join(directory, "survivor");
  const payload = Buffer.from(JSON.stringify({ ready, survivor })).toString("base64url");
  try {
    const outcome = await invoker({
      terminationGraceMs: 20,
      rootProcessSpawner: errorAfterMarkerSpawner(ready),
    }).invoke(request(`tree:${payload}`));

    assert.equal(outcome.status, "failed");
    if (outcome.status === "failed") assert.equal(outcome.error.code, "processFailed");
    await access(ready);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    await assert.rejects(access(survivor));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("rejects invalid requests before dispatch", async () => {
  const outcome = await invoker().invoke(request("success", { attempt: 0 }));
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") {
    assert.equal(outcome.error.code, "invalidRequest");
    assert.equal(outcome.error.phase, "preflight");
  }
  assert.equal(outcome.evidence.events.length, 0);

  const malformed: unknown = { ...request("success"), capabilities: ["read", 42] };
  const malformedOutcome = await invoker().invoke(malformed as InvocationRequest);
  assert.equal(malformedOutcome.status, "failed");
});

void test("acknowledges caller cancellation after confirmed tree termination", async () => {
  const controller = new AbortController();
  const pending = invoker({ terminationGraceMs: 20 }).invoke(request("hang"), {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 30);

  const outcome = await pending;
  assert.equal(outcome.status, "cancelled");
  if (outcome.status === "cancelled") assert.equal(outcome.acknowledged, true);
});

void test("uses an absolute deadline and confirms tree termination", async () => {
  const outcome = await invoker({ terminationGraceMs: 20 }).invoke(request("ignore-term"), {
    deadlineAt: new Date(Date.now() + 50).toISOString(),
  });

  assert.equal(outcome.status, "timedOut");
  if (outcome.status === "timedOut") assert.equal(outcome.acknowledged, true);
});

void test("rejects invalid deadlines deterministically", async () => {
  const outcome = await invoker().invoke(request("success"), { deadlineAt: "eventually" });
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.equal(outcome.error.code, "invalidRequest");
});

void test("does not dispatch pre-cancelled or expired requests", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-predispatch-"));
  try {
    const cancelledMarker = join(directory, "cancelled");
    const cancelledController = new AbortController();
    cancelledController.abort();
    const cancelled = await invoker().invoke(
      request(`marker:${Buffer.from(cancelledMarker).toString("base64url")}`),
      { signal: cancelledController.signal },
    );
    assert.equal(cancelled.status, "cancelled");
    await assert.rejects(access(cancelledMarker));

    const expiredMarker = join(directory, "expired");
    const expired = await invoker().invoke(
      request(`marker:${Buffer.from(expiredMarker).toString("base64url")}`),
      { deadlineAt: new Date(Date.now() - 1_000).toISOString() },
    );
    assert.equal(expired.status, "timedOut");
    await assert.rejects(access(expiredMarker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("disables all tools for an empty capability allowlist", async () => {
  const outcome = await invoker().invoke(request("success", { capabilities: [] }));
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.evidence.command.includes("--no-tools"), true);
  assert.equal(outcome.evidence.command.includes("--tools"), false);
});

void test("does not mark ambiguous mutating failures retryable", async () => {
  const outcome = await invoker().invoke(request("malformed", { execution: "mutating" }));
  assert.equal(outcome.status, "indeterminate");
  if (outcome.status === "indeterminate") {
    assert.equal(outcome.error.code, "protocolError");
    assert.equal(outcome.error.retryable, false);
  }
});

void test("allows long absolute deadlines without timer overflow", async () => {
  const outcome = await invoker().invoke(request("success"), {
    deadlineAt: "2100-01-01T00:00:00.000Z",
  });
  assert.equal(outcome.status, "succeeded");
});

void test("forwards only provider-scoped environment and omits stderr contents", async () => {
  const outcome = await new PiProcessInvoker({
    piCommand: { command: process.execPath, prefixArgs: [fixture] },
    environment: {
      PATH: `relative-entry${delimiter}${process.env["PATH"] ?? ""}`,
      OPENAI_API_KEY: "provider-secret-value",
      UNRELATED_SECRET: "must-not-be-forwarded",
    },
  }).invoke(request("environment", { model: "openai/fake-model" }));

  assert.equal(outcome.status, "succeeded");
  if (outcome.status !== "succeeded") return;
  assert.deepEqual(JSON.parse(outcome.output), { provider: true, unrelated: true, pathSafe: true });
  assert.doesNotMatch(outcome.evidence.stderr, /provider-secret-value/);
  assert.match(outcome.evidence.stderr, /stderr omitted/);
});

void test("accepts successful single and multiple pi automatic retries", async () => {
  for (const scenario of ["successful-retry", "successful-multi-retry"]) {
    const outcome = await invoker().invoke(request(scenario));
    assert.equal(outcome.status, "succeeded");
    if (outcome.status === "succeeded") assert.equal(outcome.output, "completed");
  }
});

void test("bounds aggregate JSONL input and requires a trailing LF", () => {
  const oversized = new StrictJsonlDecoder({ maxTotalBytes: 8 });
  oversized.push(Buffer.from('{"type":"event"}\n'));
  assert.match(oversized.finish().error ?? "", /stream exceeds/);

  const unterminated = new StrictJsonlDecoder();
  unterminated.push(Buffer.from('{"type":"event"}'));
  assert.match(unterminated.finish().error ?? "", /unterminated/);
});

void test("validates malformed control without dispatch or rejection", async () => {
  const malformedControl: unknown = { deadlineAt: 42 };
  const outcome = await invoker().invoke(request("success"), malformedControl as never);
  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.equal(outcome.error.code, "invalidRequest");

  const nullControl: unknown = null;
  const nullOutcome = await invoker().invoke(request("success"), nullControl as never);
  assert.equal(nullOutcome.status, "failed");
});

void test("rechecks cancellation after asynchronous preflight", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-race-"));
  const marker = join(directory, "marker");
  const controller = new AbortController();
  try {
    const pending = invoker().invoke(
      request(`marker:${Buffer.from(marker).toString("base64url")}`, { extensionPaths: [fixture] }),
      { signal: controller.signal },
    );
    queueMicrotask(() => controller.abort());
    const outcome = await pending;
    assert.equal(outcome.status, "cancelled");
    await assert.rejects(access(marker));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

void test("loads only explicit extensions and covers approved project trust", async () => {
  const outcome = await invoker().invoke(
    request("success", { extensionPaths: [fixture], projectTrust: "approve" }),
  );
  assert.equal(outcome.status, "succeeded");
  assert.equal(outcome.evidence.command.includes("--no-extensions"), true);
  assert.equal(outcome.evidence.command.includes("--approve"), true);
  assert.equal(outcome.evidence.command.includes("<approved-extension>"), true);
  assert.equal(outcome.evidence.command.includes(fixture), true); // pi entrypoint remains visible
});

void test("marks post-dispatch mutating cancellation indeterminate", async () => {
  const controller = new AbortController();
  const pending = invoker({ terminationGraceMs: 20 }).invoke(
    request("hang", { execution: "mutating" }),
    { signal: controller.signal },
  );
  setTimeout(() => controller.abort(), 30);
  const outcome = await pending;
  assert.equal(outcome.status, "indeterminate");
  if (outcome.status === "indeterminate") {
    assert.equal(outcome.error.code, "executionUncertain");
    assert.equal(outcome.error.retryable, false);
  }
});

void test("marks post-dispatch mutating timeout indeterminate", async () => {
  const outcome = await invoker({ terminationGraceMs: 20 }).invoke(
    request("hang", { execution: "mutating" }),
    { deadlineAt: new Date(Date.now() + 30).toISOString() },
  );
  assert.equal(outcome.status, "indeterminate");
  if (outcome.status === "indeterminate") {
    assert.equal(outcome.error.code, "executionUncertain");
    assert.equal(outcome.error.retryable, false);
  }
});

void test(
  "rejects Windows command shims instead of passing them to spawn",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-workflow-cmd-"));
    const command = join(directory, "pi.cmd");
    try {
      // Test-only command path is inside the isolated temporary directory.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await writeFile(command, "@echo off\r\nexit /b 0\r\n", "utf8");
      const outcome = await new PiProcessInvoker({ piCommand: { command } }).invoke(request("success"));
      assert.equal(outcome.status, "failed");
      if (outcome.status === "failed") assert.equal(outcome.error.code, "spawnFailed");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

void test("prevents descendant survival before returning cancellation outcome", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-workflow-tree-"));
  const ready = join(directory, "ready");
  const survivor = join(directory, "survivor");
  const payload = Buffer.from(JSON.stringify({ ready, survivor })).toString("base64url");
  const controller = new AbortController();
  try {
    const pending = invoker({ terminationGraceMs: 20 }).invoke(request(`tree:${payload}`), {
      signal: controller.signal,
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await access(ready);
        break;
      } catch {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
      }
    }
    await access(ready);
    controller.abort();
    const outcome = await pending;
    assert.equal(outcome.status, "cancelled");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    await assert.rejects(access(survivor));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

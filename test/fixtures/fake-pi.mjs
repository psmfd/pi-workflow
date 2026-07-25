import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { delimiter, isAbsolute } from "node:path";

const taskArgument = process.argv.find((argument) => argument.startsWith("Task: ")) ?? "Task: success";
const scenario = taskArgument.slice("Task: ".length);

const session = JSON.stringify({ type: "session", version: 3, id: "fake", cwd: process.cwd() });
const assistant = (overrides = {}) =>
  JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "completed" }],
      model: "fake/model",
      stopReason: "stop",
      usage: {
        input: 10,
        output: 4,
        cacheRead: 2,
        cacheWrite: 1,
        totalTokens: 17,
        cost: { total: 0.25 },
      },
      ...overrides,
    },
  });

if (scenario.startsWith("marker:")) {
  const marker = Buffer.from(scenario.slice("marker:".length), "base64url").toString("utf8");
  // Test-only path is generated inside an isolated temporary directory.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  writeFileSync(marker, "dispatched", "utf8");
  process.stdout.write(`${session}\n${assistant()}\n`);
} else if (scenario.startsWith("tree:")) {
  const payload = JSON.parse(Buffer.from(scenario.slice("tree:".length), "base64url").toString("utf8"));
  spawn(
    process.execPath,
    [
      "-e",
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(payload.ready)}, "ready"); setTimeout(() => fs.writeFileSync(${JSON.stringify(payload.survivor)}, "survived"), 100)`,
    ],
    { stdio: "ignore" },
  );
  setInterval(() => {}, 1_000);
} else switch (scenario) {
  case "chunked":
    process.stdout.write(`${session.slice(0, 12)}`);
    setTimeout(() => {
      process.stdout.write(`${session.slice(12)}\n${assistant()}\n`);
    }, 5);
    break;
  case "crlf":
    process.stdout.write(`${session}\r\n${assistant()}\r\n`);
    break;
  case "unknown-event":
    process.stdout.write(`${session}\n${JSON.stringify({ type: "future_event", value: 42 })}\n${assistant()}\n`);
    break;
  case "malformed":
    process.stdout.write(`${session}\n{not-json}\n`);
    setInterval(() => {}, 1_000);
    break;
  case "malformed-secret": {
    const credentialPrefix = ["Bear", "er"].join("");
    process.stdout.write(`${session}\n{"type":"event","secret":"${credentialPrefix} must-not-survive",}\n`);
    setInterval(() => {}, 1_000);
    break;
  }
  case "unterminated":
    process.stdout.write(`${session}\n${assistant()}`);
    break;
  case "no-header":
    process.stdout.write(`${assistant()}\n`);
    break;
  case "no-output":
    process.stdout.write(`${session}\n`);
    break;
  case "agent-error":
    process.stdout.write(`${session}\n${assistant({ content: [], stopReason: "error", errorMessage: "provider failed" })}\n`);
    break;
  case "contradictory":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error", errorMessage: "provider failed" })}\n${assistant()}\n`,
    );
    break;
  case "successful-retry":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error", errorMessage: "provider failed" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 0, errorMessage: "omitted" })}\n` +
        `${assistant()}\n${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 1 })}\n`,
    );
    break;
  case "successful-multi-retry":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 1 })}\n` +
        `${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 2 })}\n${assistant()}\n` +
        `${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 })}\n`,
    );
    break;
  case "retry-mismatch":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 1 })}\n${assistant()}\n` +
        `${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 })}\n`,
    );
    break;
  case "retry-dangling":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 1 })}\n${assistant()}\n`,
    );
    break;
  case "retry-skipped-attempt":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 2 })}\n${assistant()}\n` +
        `${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 })}\n`,
    );
    break;
  case "retry-consecutive-start":
    process.stdout.write(
      `${session}\n${assistant({ content: [], stopReason: "error" })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 1 })}\n` +
        `${JSON.stringify({ type: "auto_retry_start", attempt: 2 })}\n${assistant()}\n` +
        `${JSON.stringify({ type: "auto_retry_end", success: true, attempt: 2 })}\n`,
    );
    break;
  case "nonzero":
    process.stdout.write(`${session}\n`);
    process.stderr.write("child failure\n");
    process.exitCode = 7;
    break;
  case "large-stderr":
    process.stdout.write(`${session}\n`);
    process.stderr.write("x".repeat(300_000));
    process.exitCode = 7;
    break;
  case "environment":
    process.stdout.write(
      `${session}\n${assistant({
        content: [{
          type: "text",
          text: JSON.stringify({
            provider: process.env.OPENAI_API_KEY === "provider-secret-value",
            unrelated: process.env.UNRELATED_SECRET === undefined,
            pathSafe: (process.env.PATH ?? "").split(delimiter).every((entry) => isAbsolute(entry)),
          }),
        }],
      })}\n`,
    );
    process.stderr.write(`key=${process.env.OPENAI_API_KEY}\n`);
    break;
  case "hang":
    setInterval(() => {}, 1_000);
    break;
  case "ignore-term":
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1_000);
    break;
  default:
    process.stdout.write(`${session}\n${assistant()}\n`);
}

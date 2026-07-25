import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-workflow-smoke-"));
const npmCliFromEnvironment = process.env["npm_execpath"];
if (npmCliFromEnvironment === undefined) {
  throw new Error("smoke-package must run through an npm script");
}
const npmCli: string = npmCliFromEnvironment;

function runNpm(args: string[], options: { cwd: string; encoding: "utf8" }): string;
function runNpm(args: string[], options: { cwd: string; stdio: "pipe" }): Buffer;
function runNpm(
  args: string[],
  options: { cwd: string; encoding?: "utf8"; stdio?: "pipe" },
): string | Buffer {
  return execFileSync(process.execPath, [npmCli, ...args], options);
}

try {
  const packOutput = runNpm(
    ["pack", "--json", "--pack-destination", temporaryRoot],
    { cwd: packageRoot, encoding: "utf8" },
  );
  const packed = JSON.parse(packOutput) as Array<{ filename: string }>;
  const filename = packed[0]?.filename;
  if (filename === undefined) {
    throw new Error("npm pack did not return a package filename");
  }

  const tarball = join(temporaryRoot, filename);
  writeFileSync(
    join(temporaryRoot, "package.json"),
    `${JSON.stringify(
      {
        private: true,
        dependencies: {
          "@earendil-works/pi-coding-agent": "0.81.1",
          "@psmfd/pi-workflow": `file:${tarball}`,
        },
      },
      undefined,
      2,
    )}\n`,
  );

  runNpm(["install", "--omit=dev", "--ignore-scripts"], {
    cwd: temporaryRoot,
    stdio: "pipe",
  });

  const agentDirectory = join(temporaryRoot, "agent");
  mkdirSync(agentDirectory);
  const piCli = join(
    temporaryRoot,
    "node_modules",
    "@earendil-works",
    "pi-coding-agent",
    "dist",
    "cli.js",
  );
  const loadSentinel = `pi-workflow-loaded-${randomUUID()}`;
  const piOutput = execFileSync(
    process.execPath,
    [
      piCli,
      "--no-extensions",
      "-e",
      join(temporaryRoot, "node_modules", "@psmfd", "pi-workflow"),
      "--no-approve",
      "--no-session",
      "--no-tools",
      "--offline",
      "--list-models",
    ],
    {
      cwd: temporaryRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDirectory,
        PI_OFFLINE: "1",
        PI_WORKFLOW_LOAD_SENTINEL: loadSentinel,
      },
      stdio: "pipe",
    },
  );
  if (!piOutput.split(/\r?\n/u).includes(loadSentinel)) {
    throw new Error("packed pi-workflow extension did not execute its factory");
  }
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

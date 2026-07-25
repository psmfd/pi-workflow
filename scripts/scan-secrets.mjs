import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const maximumFileBytes = 2 * 1024 * 1024;
const repositoryRoot = resolve(".");
const signatures = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu],
  ["GitHub token", /\b(?:gh[opurs]_[A-Za-z0-9_]{36,255}|github_pat_[A-Za-z0-9_]{20,255})\b/gu],
  ["signed JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu],
  ["Bearer credential", /\bBearer[\t ]+[A-Za-z0-9._~+/=-]{16,}/gu],
];

const listed = spawnSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { encoding: "buffer", shell: false },
);
if (listed.status !== 0) {
  if (listed.stderr !== null) process.stderr.write(listed.stderr);
  console.error("ERROR [secret-scan] unable to enumerate authored files");
  console.error("");
  console.error("FAIL — 1 error(s), 0 warning(s)");
  process.exitCode = 2;
} else {
  const files = listed.stdout
    .toString("utf8")
    .split("\0")
    .filter((file) => file.length > 0);
  const executionErrors = [];
  const findings = [];
  let scanned = 0;

  for (const file of files) {
    const absolutePath = resolve(repositoryRoot, file);
    const repositoryRelative = relative(repositoryRoot, absolutePath);
    if (
      isAbsolute(repositoryRelative) ||
      repositoryRelative === ".." ||
      repositoryRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
    ) {
      executionErrors.push(`${file}: path escapes the repository`);
      continue;
    }

    try {
      // The path is contained under the repository and comes from Git's NUL-delimited listing.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const metadata = lstatSync(absolutePath);
      if (!metadata.isFile()) {
        executionErrors.push(`${file}: symbolic links and non-regular files are not scannable`);
        continue;
      }
      if (metadata.size > maximumFileBytes) {
        executionErrors.push(`${file}: exceeds the ${maximumFileBytes}-byte scan limit`);
        continue;
      }

      // The same validated regular file is read immediately after lstat.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const bytes = readFileSync(absolutePath);
      if (bytes.includes(0)) {
        executionErrors.push(`${file}: contains NUL bytes and cannot be safely scanned`);
        continue;
      }

      scanned += 1;
      const content = bytes.toString("utf8");
      for (const [name, signature] of signatures) {
        signature.lastIndex = 0;
        for (const match of content.matchAll(signature)) {
          const line = content.slice(0, match.index).split("\n").length;
          findings.push(`${file}:${line}: ${name}`);
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      executionErrors.push(`${file}: ${message}`);
    }
  }

  for (const error of executionErrors) {
    console.error(`ERROR [secret-scan] ${error}`);
  }
  for (const finding of findings) {
    console.error(`ERROR [secret-scan] ${finding}`);
  }

  console.log("");
  const errorCount = executionErrors.length + findings.length;
  if (errorCount > 0) {
    console.error(`FAIL — ${errorCount} error(s), 0 warning(s)`);
    process.exitCode = executionErrors.length > 0 ? 2 : 1;
  } else {
    console.log(`OK    [secret-scan] ${scanned} authored text file(s) scanned`);
    console.log("PASS — 0 error(s), 0 warning(s)");
  }
}

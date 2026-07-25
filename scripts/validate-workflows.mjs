import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

const workflowDirectory = ".github/workflows";

function reportExecutionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR [workflow-validation] ${message}`);
  console.error("");
  console.error("FAIL — 1 error(s), 0 warning(s)");
  process.exitCode = 2;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

try {
  const workflowFiles = readdirSync(workflowDirectory)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  const errors = [];
  let actionCount = 0;

  function inspectActions(value, file) {
    if (Array.isArray(value)) {
      for (const item of value) inspectActions(item, file);
      return;
    }
    if (value === null || typeof value !== "object") return;

    for (const [key, child] of Object.entries(value)) {
      if (key === "uses" && typeof child === "string") {
        actionCount += 1;
        if (
          !child.startsWith("./") &&
          !/^docker:\/\/[A-Za-z0-9_./:-]+@sha256:[0-9a-f]{64}$/u.test(child) &&
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/u.test(child) &&
          !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u.test(child)
        ) {
          errors.push(
            `${file}: external action '${child}' must use a full commit SHA or Docker sha256 digest`,
          );
        }
      }
      inspectActions(child, file);
    }
  }

  for (const name of workflowFiles) {
    const file = join(workflowDirectory, name);
    // Names are constrained to direct .yml/.yaml children of the fixed workflow directory.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const document = parseDocument(readFileSync(file, "utf8"));
    for (const error of document.errors) {
      errors.push(`${file}: ${error.message}`);
    }
    if (document.errors.length === 0) {
      const workflow = document.toJS();
      if (!isPlainRecord(workflow)) {
        errors.push(`${file}: workflow root must be a mapping`);
        continue;
      }
      if (!("on" in workflow)) {
        errors.push(`${file}: workflow must declare triggers with 'on'`);
      }
      if (!isPlainRecord(workflow.permissions)) {
        errors.push(`${file}: workflow must declare explicit root permissions`);
      }
      if (!isPlainRecord(workflow.jobs) || Object.keys(workflow.jobs).length === 0) {
        errors.push(`${file}: workflow must declare a non-empty jobs mapping`);
      } else {
        for (const [jobName, job] of Object.entries(workflow.jobs)) {
          if (!isPlainRecord(job)) {
            errors.push(`${file}: job '${jobName}' must be a mapping`);
          } else if (!("runs-on" in job) && !("uses" in job)) {
            errors.push(`${file}: job '${jobName}' must declare 'runs-on' or reusable-workflow 'uses'`);
          }
          if (isPlainRecord(job) && "steps" in job && !Array.isArray(job.steps)) {
            errors.push(`${file}: job '${jobName}' steps must be an array`);
          }
        }
      }
      inspectActions(workflow, file);
    }
  }

  if (workflowFiles.length === 0) {
    errors.push(`${workflowDirectory}: no workflow files found`);
  }

  for (const error of errors) {
    console.error(`ERROR [workflow-validation] ${error}`);
  }

  console.log("");
  if (errors.length > 0) {
    console.error(`FAIL — ${errors.length} error(s), 0 warning(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `OK    [workflow-validation] ${workflowFiles.length} workflow(s), ${actionCount} pinned action use(s)`,
    );
    console.log("PASS — 0 error(s), 0 warning(s)");
  }
} catch (error) {
  reportExecutionFailure(error);
}

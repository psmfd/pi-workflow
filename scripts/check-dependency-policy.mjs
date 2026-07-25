import { readFileSync } from "node:fs";

function reportExecutionFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ERROR [dependency-policy] ${message}`);
  console.error("");
  console.error("FAIL — 1 error(s), 0 warning(s)");
  process.exitCode = 2;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireRecord(value, label, optional = false) {
  if (value === undefined && optional) return {};
  if (!isPlainRecord(value)) throw new Error(`${label} must be a JSON object`);
  return value;
}

try {
  const packageJson = requireRecord(
    JSON.parse(readFileSync("package.json", "utf8")),
    "package.json root",
  );
  const packageLock = requireRecord(
    JSON.parse(readFileSync("package-lock.json", "utf8")),
    "package-lock.json root",
  );
  const errors = [];

  const developmentDependencies = requireRecord(
    packageJson.devDependencies,
    "package.json devDependencies",
    true,
  );
  for (const [name, version] of Object.entries(developmentDependencies)) {
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) {
      errors.push(`devDependency '${name}' must use an exact semantic version, found '${version}'`);
    }
  }

  const peerDependencies = requireRecord(
    packageJson.peerDependencies,
    "package.json peerDependencies",
    true,
  );
  if (peerDependencies["@earendil-works/pi-coding-agent"] !== "*") {
    errors.push("@earendil-works/pi-coding-agent peerDependency must use pi's documented '*' range");
  }

  const runtimeSections = [
    ["dependencies", packageJson.dependencies],
    ["optionalDependencies", packageJson.optionalDependencies],
  ];
  for (const [section, entries] of runtimeSections) {
    const record = requireRecord(entries, `package.json ${section}`, true);
    if (Object.keys(record).length > 0) {
      errors.push(`${section} require an explicit architecture review`);
    }
  }

  for (const [section, entries] of [
    ["bundledDependencies", packageJson.bundledDependencies],
    ["bundleDependencies", packageJson.bundleDependencies],
  ]) {
    if (entries !== undefined && !Array.isArray(entries)) {
      throw new Error(`package.json ${section} must be an array when present`);
    }
    if ((entries?.length ?? 0) > 0) {
      errors.push(`${section} require an explicit architecture review`);
    }
  }

  for (const name of Object.keys(peerDependencies)) {
    if (name !== "@earendil-works/pi-coding-agent") {
      errors.push(`peerDependency '${name}' requires an explicit architecture review`);
    }
  }

  const lockPackages = requireRecord(packageLock.packages, "package-lock.json packages");
  const lockedRoot = requireRecord(lockPackages[""], "package-lock.json root package");
  const lockedDevelopmentDependencies = requireRecord(
    lockedRoot.devDependencies,
    "package-lock.json root devDependencies",
    true,
  );
  const lockedDevelopmentMap = new Map(Object.entries(lockedDevelopmentDependencies));
  for (const [name, version] of Object.entries(developmentDependencies)) {
    if (lockedDevelopmentMap.get(name) !== version) {
      errors.push(`package-lock root does not match devDependency '${name}' at '${version}'`);
    }
  }
  for (const name of lockedDevelopmentMap.keys()) {
    if (!Object.hasOwn(developmentDependencies, name)) {
      errors.push(`package-lock root contains undeclared devDependency '${name}'`);
    }
  }

  for (const error of errors) {
    console.error(`ERROR [dependency-policy] ${error}`);
  }

  console.log("");
  if (errors.length > 0) {
    console.error(`FAIL — ${errors.length} error(s), 0 warning(s)`);
    process.exitCode = 1;
  } else {
    console.log(
      `OK    [dependency-policy] ${Object.keys(developmentDependencies).length} exact development pin(s) verified`,
    );
    console.log("PASS — 0 error(s), 0 warning(s)");
  }
} catch (error) {
  reportExecutionFailure(error);
}

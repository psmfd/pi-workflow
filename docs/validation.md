# Validation and security checks

The repository uses Node.js 22.19 or newer and a committed npm lockfile. Run the complete local baseline from a clean checkout:

```sh
npm ci
npm run check
npm run smoke:pi
npm run test:coverage
npm run security
```

## Validation layers

`npm run check` runs these deterministic checks:

1. TypeScript type-checking without output.
2. ESLint, including typed TypeScript and security rules.
3. Markdown linting.
4. Unit tests.
5. GitHub Actions YAML and immutable action-pin validation.
6. Exact dependency-policy validation.
7. Authored-file secret-pattern scanning.

`npm test` includes subprocess acceptance coverage for the supported subagent invocation seam. A scripted fake pi executable exercises command construction, JSONL framing, failure classification, cancellation, deadlines, and termination escalation without loading a model or making network calls.

`npm run smoke:pi` packs the package, installs it with production semantics in an isolated temporary directory, and verifies that pi executes the packaged extension factory. The child pi process runs offline without user extensions, tools, approval files, or a persisted session.

`npm run security` repeats dependency-policy and secret checks, blocks critical vulnerabilities across the complete development graph, and then applies zero-tolerance auditing to production dependencies. Lower-severity development findings remain visible in audit output and are tracked through repository-enabled Dependabot alerts and security updates. Dependency review prevents new high-severity vulnerable packages from entering through pull requests; CodeQL covers source-level vulnerabilities and is not treated as dependency-CVE analysis. The baseline never rewrites the lockfile with `npm audit fix`.

## GitHub checks

Pull requests to `dev` or `main` run validation on Linux, macOS, and Windows with Node.js 22.19. A separate job reports test coverage. Security automation adds dependency review and CodeQL analysis, while Dependabot monitors both npm and GitHub Actions dependencies.

The protected `dev` branch requires these six pull-request check contexts:

- `validate (ubuntu-latest)`
- `validate (macos-latest)`
- `validate (windows-latest)`
- `coverage`
- `dependency-review`
- `codeql`

Renaming a job requires a coordinated ruleset update so the branch is not left unprotected or locked by a stale context.

Every external GitHub Action is pinned to a full commit SHA. Docker actions, if introduced, must use a full `sha256` digest. The adjacent version comment records the reviewed upstream tag; automated updates must preserve immutable pinning.

## Exit behavior

Validation commands exit non-zero on errors. Repository scripts use exit code `1` for findings and `2` for a validation precondition or execution failure. Their final summary is either `PASS` or `FAIL` with error and warning counts.

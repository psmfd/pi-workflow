# Contributing to pi-workflow

Thank you for improving `pi-workflow`. Contributions must preserve deterministic execution, least privilege, and the compatibility commitments in the [governance policy](docs/governance.md).

## Before starting

Search the [issue tracker](https://github.com/psmfd/pi-workflow/issues) before opening new work. Substantive changes should have an issue that states scope and acceptance criteria. Security vulnerabilities must follow the private process in [SECURITY.md](SECURITY.md), not a public issue.

## Development setup

Requirements:

- Node.js 22.19 or newer
- npm

Prepare a clean checkout and run the baseline:

```sh
npm ci
npm run check
npm run smoke:pi
npm run test:coverage
npm run security
```

See [Validation and security checks](docs/validation.md) for what each command enforces.

## Branches and commits

Normal work follows this flow:

1. Start a short-lived branch from current `dev`.
2. Name it `<type>/<kebab-case-summary>`, for example `feat/run-journal` or `docs/release-policy`.
3. Use Conventional Commit messages: `<type>(<optional-scope>): <lowercase imperative description>`.
4. Push the branch and open a pull request to `dev`.

Common types are `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, and `chore`. Use `!` and a `BREAKING CHANGE:` footer when a commit intentionally breaks a public contract.

Do not rewrite shared branch history. Delete merged topic branches locally and remotely after verifying the merge.

## Pull requests

A pull request must include:

- **Summary** — what changed and why.
- **Test Plan** — commands and relevant manual checks performed.
- **Risk** — compatibility, security, migration, or operational risks.
- A closing or reference link to the governing issue.

Keep changes focused. Update tests and documentation with the behavior they describe. Resolve review threads and rerun affected checks after the final change.

A contribution is mergeable when:

- its acceptance criteria are satisfied;
- required GitHub checks pass;
- dependency and lockfile changes are synchronized and reviewed;
- security-sensitive permissions or dependencies have explicit justification;
- compatibility and documentation impacts are addressed;
- reviewer findings are resolved or recorded as tracked follow-up work.

Topic pull requests are squash-merged into `dev`. Maintainers may close changes that cannot meet these requirements or that conflict with project direction.

## Deterministic and secure changes

Contributions must not depend on operator credentials, user-level pi configuration, persisted sessions, mutable global state, or an unrecorded network response. Tests should use isolated temporary state and explicit fixtures.

Additional requirements:

- Commit `package-lock.json` with every manifest dependency change.
- Keep direct development dependencies exactly pinned.
- Request architecture and security review before adding runtime, optional, bundled, or additional peer dependencies.
- Pin external GitHub Actions to full commit SHAs and Docker actions to full image digests.
- Keep workflow permissions read-only by default and elevate them only for the narrow job that requires it.
- Never expose secrets to untrusted pull-request code or use `pull_request_target` to execute contributed code.
- Never commit credentials, realistic secret fixtures, private keys, or tokens to source, history, artifacts, or logs.

## Ownership and review

Repository ownership is declared in [`.github/CODEOWNERS`](.github/CODEOWNERS). Code ownership identifies accountable maintainers; it does not waive required checks or create an independent approval where only one maintainer is available.

Changes to workflow execution contracts, evidence identity, compatibility guarantees, release controls, or dependency policy require maintainer review. Architectural decisions should be recorded before implementation when they establish or replace a durable project convention.

## Releases

Contributors do not publish official packages, create release tags, or merge directly to `main`. Releases are maintainer-controlled promotions from `dev` under the [release policy](docs/governance.md#release-policy). The package remains private until trusted publication work in [issue #25](https://github.com/psmfd/pi-workflow/issues/25) is complete.

# Project governance

This document defines ownership, contribution, compatibility, and release policy for `pi-workflow`. Operational commands belong in [CONTRIBUTING.md](../CONTRIBUTING.md), and check behavior belongs in [validation.md](validation.md).

## Principles and roles

The project prioritizes deterministic workflow execution, reviewable evidence, least privilege, and explicit compatibility over convenience.

- **Maintainers** own repository policy, architecture decisions, security response, compatibility declarations, merge decisions, and releases.
- **Contributors** propose focused changes, supply tests and documentation, and address review findings.
- **Reviewers** evaluate requirement fidelity, design, security, compatibility, and validation evidence. Approval does not replace automated gates.
- **Workflow executors** implement bounded tasks under explicit contracts. They do not redefine scope, evidence identity, approval state, or release authority.

The current ownership map is in [`.github/CODEOWNERS`](../.github/CODEOWNERS). A solo maintainer may merge qualifying topic work to `dev`, so automated checks and recorded evidence remain mandatory even when independent approval is unavailable. Stable promotion to `main` still requires the approval and last-push review enforced by the `main` ruleset.

## Contribution and merge policy

`dev` is the protected integration branch and the repository default. Normal topic branches start from `dev` and target `dev`. They are squash-merged after satisfying the criteria in [CONTRIBUTING.md](../CONTRIBUTING.md).

`main` is the protected stable branch. It advances through a `dev` to `main` promotion pull request. Contributors must not push or merge directly to either protected branch. Force pushes and branch deletion are prohibited by repository rulesets.

Urgent stable corrections still move through `dev` and a promotion pull request. If a required check or rule is misconfigured, pause the promotion and restore a valid reviewed path rather than pushing directly or rewriting branch history. Record the incident and corrective action in the repository.

Merged topic branches are deleted. Shared branch history is never rebased or rewritten.

## Labels and milestones

Executable issues use repository labels to communicate:

- work type or domain, such as `documentation`, `extension`, or `orchestration`;
- priority, such as `priority:high` or `priority:medium`;
- delivery phase, such as `phase:foundation`, `phase:design`, or `phase:runtime`;
- decision requirements such as `adr-required` where applicable.

Leaf work planned for a release is assigned to that release milestone. Tracking parents may remain outside a milestone when their milestone-assigned child issues are the executable delivery plan. Closing a milestone requires every included issue to be completed or explicitly moved with a recorded reason; silently dropping unfinished scope is not permitted.

## Compatibility policy

The package uses Semantic Versioning once releases begin. Before `1.0.0`, compatibility is interpreted as follows:

- `0.Y.0` may introduce features and intentional breaking contract changes;
- `0.y.Z` contains backward-compatible fixes and security corrections;
- documentation, test, CI, and internal maintenance changes do not require a release unless they affect distributed behavior.

Breaking changes include incompatible alterations to commands, configuration, workflow state, evidence identity, persisted data, executor contracts, public TypeScript APIs, or documented pi/Node support. They require an explicit migration note and an architecture decision when they establish or replace a durable convention.

The peer dependency range expresses installability, not a promise that every pi version is tested. Each release must state the exact pi and Node versions validated in CI. A version enters the supported matrix only after deterministic package and workflow tests pass against it. The release notes identify known limitations and any compatibility change.

Pre-release development builds (`0.0.0-development`) carry no stability guarantee. After the first release, only the latest published pre-1.0 minor line receives routine fixes unless a release note states otherwise.

## Release policy

Releases are milestone-driven and maintainer-controlled. A release candidate is eligible for promotion when:

1. milestone scope is complete or explicitly deferred;
2. all required `dev` checks pass on the candidate commit;
3. tests, cross-platform validation, package smoke testing, dependency policy, secret scanning, production audit, dependency review, CodeQL, and coverage reporting are successful as applicable;
4. release notes describe user-visible changes, compatibility, migration, and known risks;
5. the package version and release tag are unique and consistent;
6. no unresolved critical or high-severity release-blocking finding remains.

The maintainer opens a promotion pull request from `dev` to `main`. The same validation and security workflows must pass before merge. After the protected `main` commit is verified, the maintainer creates an immutable annotated `vX.Y.Z` tag and matching GitHub Release from that commit.

The current package is private and must not be published to npm. Official npm publication is blocked until [issue #25](https://github.com/psmfd/pi-workflow/issues/25) provides trusted OIDC publication, a protected release environment, build-once artifact promotion, digest verification, and provenance. Official releases must never rely on a maintainer's local `npm publish` or a long-lived npm token.

Release tags and published versions are immutable. A faulty release is corrected by reverting or fixing forward on `dev`, promoting again, and issuing a new patch version. Tags and release artifacts are not deleted and recreated to conceal or replace a released build.

## Security and change control

Security reports follow [SECURITY.md](../SECURITY.md). Secrets never belong in issues, pull requests, fixtures, artifacts, or logs.

Changes to this governance policy require a pull request with the same checks as code changes. Changes that materially alter branch strategy, release authority, compatibility guarantees, or security boundaries require an architecture decision or an explicitly labeled governance issue before implementation.

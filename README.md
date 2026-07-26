# pi-workflow

Deterministic typed workflow extension for [pi](https://github.com/earendil-works/pi).

> [!NOTE]
> The package is under active development. The initial deterministic review workflows are tracked in the [`v0.1` milestone](https://github.com/psmfd/pi-workflow/milestone/1).

## Package status

This repository is the canonical source for `@psmfd/pi-workflow`. The package exports a loadable TypeScript pi extension entrypoint, versioned workflow contracts, a pure reducer and replay engine, and a synchronized file-backed run journal. Workflow commands and concrete review definitions remain on the ordered issue roadmap.

## Development

Requirements:

- Node.js 22.19 or newer
- npm

Install dependencies and run the local quality gates:

```sh
npm ci
npm run check
npm run smoke:pi
npm run test:coverage
npm run security
```

The `smoke:pi` command packs the project, installs it in an isolated temporary environment, and verifies that pi executes the packaged extension factory. Validation runs without loading the operator's extensions or settings.

See [Validation and security checks](docs/validation.md) for the complete local and GitHub Actions baseline.

## Architecture decisions

- [Runtime contracts](docs/runtime-contracts.md) — versioned workflow, journal, scope, evidence, transition, recovery, and compatibility contracts.
- [ADR 0001: Supported subagent invocation seam](docs/adr/0001-supported-subagent-invocation-seam.md) — isolates one-shot pi JSON subprocesses behind a typed package-owned invoker.
- [ADR 0002: Deterministic workflow runtime](docs/adr/0002-deterministic-workflow-runtime.md) — selects typed definitions and an append-only event journal.
- [ADR 0003: File-backed workflow journal durability](docs/adr/0003-file-backed-workflow-journal-durability.md) — defines locking, replay, corruption, and synchronized commit semantics.

## Project policy

- [Contributing](CONTRIBUTING.md) — development workflow, review, and merge criteria
- [Governance](docs/governance.md) — ownership, compatibility, milestones, and releases
- [Security](SECURITY.md) — private vulnerability reporting and supported versions
- [MIT License](LICENSE) — permissions and conditions

Generated CocoIndex data under `.cocoindex_code/` is local tooling state and is not committed.

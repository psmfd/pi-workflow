# pi-workflow

Deterministic typed workflow extension for [pi](https://github.com/earendil-works/pi).

> [!NOTE]
> The package is under active development. The initial deterministic review workflows are tracked in the [`v0.1` milestone](https://github.com/psmfd/pi-workflow/milestone/1).

## Package status

This repository is the canonical source for `@psmfd/pi-workflow`. The current package exports a loadable TypeScript pi extension entrypoint; workflow runtime features will be added through the ordered issue roadmap.

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

Generated CocoIndex data under `.cocoindex_code/` is local tooling state and is not committed.

# Contributing to Rollberry

Thank you for contributing to Rollberry.

## Before You Start

- Open an issue for bugs, feature requests, or larger changes before starting
  implementation.
- For security issues, do not open a public issue. Use
  https://co-r-e.com/contact instead.
- By contributing, you agree that your changes will be distributed under the
  MIT license used by this repository.

## Development Setup

```bash
corepack pnpm install
corepack pnpm exec playwright install chromium
corepack pnpm check
corepack pnpm test
```

## Pull Request Expectations

- Keep changes focused and avoid mixing unrelated work.
- Update docs when CLI behavior or release/operational workflow changes.
- Add or update tests when behavior changes.
- Keep `README.md`, `CHANGELOG.md`, and sample config files aligned with the
  code when relevant.

## Branch Protection and Reviews

The protected branches are:

- `main`
- `develop`
- `release/*`

For contributors other than `mokuwaki`:

- direct push is not allowed on protected branches
- merge requires at least one approval
- the latest push must still be approved by someone else

`mokuwaki` is the only configured bypass user for these protected branches.

## Release Notes

Rollberry remains on the `v0.x.x` line for now. Release prep should update:

- `package.json`
- `CHANGELOG.md`
- any user-facing docs affected by the release

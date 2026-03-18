# Changelog

All notable changes to this project will be documented in this file.

The format is based on Keep a Changelog and the project stays on the `v0.x.x`
line until the CLI surface and capture behavior settle.

## [0.1.8] - 2026-03-19

### Added

- Multi-page capture support.

### Changed

- Reduced default auto-scroll speed from 1800 px/s to 800 px/s for better
  readability during capture.
- GitHub Actions publish workflow now uses token-based authentication.

## [0.1.3] - 2026-03-15

### Changed

- README now includes a dedicated `Using With npx` section with version-pinned
  examples and common usage patterns.

## [0.1.2] - 2026-03-15

### Added

- `SECURITY.md`, `CONTRIBUTING.md`, GitHub issue forms, and a pull request
  template.
- Contact guidance pointing users to https://co-r-e.com/contact where private
  contact is required.

### Changed

- MIT copyright holder is now `CORe Inc.`.
- Branch protection policy now also covers `develop` and `release/*`, with
  `mokuwaki` as the only bypass user.

## [0.1.1] - 2026-03-15

### Added

- MIT license metadata and `LICENSE` file for open source distribution.
- GitHub Actions trusted publishing workflow for npm releases on `v*` tags.
- Maintainer release process documentation for `npx rollberry ...` distribution.

### Changed

- README rewritten around real `npx` usage, common capture examples, and
  operational troubleshooting.
- Package metadata now includes repository, homepage, bug tracker, and keywords.

## [0.1.0] - 2026-03-15

### Added

- Initial public CLI release for smooth top-to-bottom page capture.
- `localhost`, `127.0.0.1`, and self-signed `https://localhost` support.
- Sidecar manifest and JSONL log output.
- Regression suite runner and fixture-backed integration tests.

### [0.3.1](https://github.com/esroyo/bump-workspaces/compare/v0.3.0...v0.3.1) (2025.08.18)

- fix: ensure either individual or consolidated release notes
- docs: tidy README

### [0.3.0](https://github.com/esroyo/bump-workspaces/compare/v0.2.6...v0.3.0) (2025.08.17)

- feat!: remove publishMode and keep compat with upstream
- feat: add github links on generated notes

### [0.2.6](https://github.com/esroyo/bump-workspaces/compare/v0.2.5...v0.2.6) (2025.08.15)

- docs: add tag options info

### [0.2.5](https://github.com/esroyo/bump-workspaces/compare/v0.2.4...v0.2.5) (2025.08.15)

- fix: better resiliency on single-package config read

### [0.2.4](https://github.com/esroyo/bump-workspaces/compare/v0.2.3...v0.2.4) (2025.08.15)

- fix: enable dry-run for git tag creation

### [0.2.3](https://github.com/esroyo/bump-workspaces/compare/v0.2.2...v0.2.3) (2025.08.14)

- fix: linting errors on cli
- docs: add info about tagging and merge strategies

### [0.2.2](https://github.com/esroyo/bump-workspaces/compare/v0.2.1...v0.2.2) (2025.08.14)

- feat: add tagging to the bump/release process

### [0.2.1](https://github.com/esroyo/bump-workspaces/compare/v0.2.0...v0.2.1) (2025.08.14)

- fix: bumping version on single-packages
- fix: avoid hardcoded "Releases.md" comment
- fix: avoid error on git checkout cmd
- chore: avoid dev files on publish

### [0.2.0](https://github.com/esroyo/bump-workspaces/compare/v0.1.x...v0.2.0) (2025.08.14)

- feat: support standalone packages
- feat: add per-package mode
- feat: allow arg --release-note-path via cli
- fix: git restoration using wrong cmd
- fix: handle scopeless commits for single packages
- docs: update ci/codecov urls
- docs: improve per-package and single package sections
- refactor: change fork pkg name to @esroyo/deno-bump-workspaces
- chore: manual bump to 0.2.0

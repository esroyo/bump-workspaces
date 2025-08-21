### [0.3.7](https://github.com/esroyo/bump-workspaces/compare/v0.3.6...v0.3.7) (2025.08.21)

- fix: avoid error with empty root
  ([646112f](https://github.com/esroyo/bump-workspaces/commit/646112fa57642fb3c6affc4ffd3d6933c97384f0))

### [0.3.6](https://github.com/esroyo/bump-workspaces/compare/v0.3.5...v0.3.6) (2025.08.21)

- fix: accept glob patterns in workspace values
  ([8be72c3](https://github.com/esroyo/bump-workspaces/commit/8be72c3b388d3d9c99db5e618e0c84311d66d991))

### [0.3.5](https://github.com/esroyo/bump-workspaces/compare/v0.3.4...v0.3.5) (2025.08.21)

- refactor: simplify get deno config on single-pkg
  ([06107da](https://github.com/esroyo/bump-workspaces/commit/06107da4b0a2c14f338fcd87dba66bd6dfd1143c))

### [0.3.4](https://github.com/esroyo/bump-workspaces/compare/v0.3.3...v0.3.4) (2025.08.20)

- refactor: simplify single-pkg fallback
  ([b7c97cf](https://github.com/esroyo/bump-workspaces/commit/b7c97cf280cf719ac38dc7f986bd6281da2ef680))
- refactor: rename internal option _quiet as quiet
  ([a621799](https://github.com/esroyo/bump-workspaces/commit/a621799a90f9391551e7b4a0d7a7ff0cbe0ddfb3))
- refactor: remove unused git options
  ([da8b2ef](https://github.com/esroyo/bump-workspaces/commit/da8b2ef44bfa2c6c111ba969121edced360817ab))
- chore: add clean task
  ([ac03687](https://github.com/esroyo/bump-workspaces/commit/ac036877677db960111227ad9353ba90849e7bbd))

### [0.3.3](https://github.com/esroyo/bump-workspaces/compare/v0.3.2...v0.3.3) (2025.08.20)

- fix: make individual notes similar to single-pkg notes
  ([e90970b](https://github.com/esroyo/bump-workspaces/commit/e90970b0b7fd81b0d9b9c312f95535fb266b1dfe))

### [0.3.2](https://github.com/esroyo/bump-workspaces/compare/v0.3.1...v0.3.2) (2025.08.20)

- fix: execute deno fmt for all release notes
  ([18c2664](https://github.com/esroyo/bump-workspaces/commit/18c2664cbf15e6f5639a7b4c7b165e21028f4602))
- fix: defined git constants before generating notes
  ([63f2ca3](https://github.com/esroyo/bump-workspaces/commit/63f2ca3642dfaeceae3f5ed799dfd33b0dc97490))
- fix: avoid write release notes on dry-run
  ([5579cd0](https://github.com/esroyo/bump-workspaces/commit/5579cd0503b7b000d46d95acc51a72cd0e1d98f0))
- refactor: unify release notes and tag serach fns
  ([9bfa710](https://github.com/esroyo/bump-workspaces/commit/9bfa710f8f2ec47769705329fdc662caeadf82f8))
- chore: changelog fmt
  ([bedf350](https://github.com/esroyo/bump-workspaces/commit/bedf350cdd6889518ccf3f0687b00a7812edf785))

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

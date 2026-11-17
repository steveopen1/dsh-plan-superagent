# NOTICE

This package bundles code from two upstream projects.

## dsh-plan-board (vendored under `src/board/` and `src/client/`)

- Upstream: https://github.com/hoyyang/dsh-plan-board (v0.2.2, tag `v0.2.2`)
- License: BSD-3-Clause
- Copyright: see `NOTICE-plan-board.md`
- Local changes: Windows-compatible absolute-path detection (`src/board/pathutil.ts`),
  cross-platform scope-prefix matching, and the superagent bridge.

## dsh-superagent (not vendored; declared as a dependency)

- Upstream: https://github.com/deepseek-ai/dsh-superagent-prototype (MIT)
- Windows fork: https://github.com/steveopen1/dsh-superagent (MIT)

The MIT license of this package applies to the code in this repository that is not
covered by the BSD-3-Clause terms of dsh-plan-board.

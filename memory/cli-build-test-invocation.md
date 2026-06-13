---
name: cli-build-test-invocation
description: How to build/test the overlord-cli workspace when `yarn` reports "command not found: tsc"
metadata:
  type: project
---

In this repo, `yarn workspace overlord-cli build` (and `yarn build:db`, `yarn workspace ... test`) fail with `command not found: tsc` — yarn's run PATH does not include the hoisted `node_modules/.bin`.

**How to apply:** Invoke the binaries directly from the repo-root `node_modules/.bin` instead:
- Typecheck CLI: `cd cli && ../node_modules/.bin/tsc --project tsconfig.build.json --noEmit`
- Build CLI dist: `cd cli && ../node_modules/.bin/tsc --project tsconfig.build.json`
- Run CLI tests: `cd cli && ../node_modules/.bin/tsx --test 'test/**/*.test.ts'`

`cli/dist/` is gitignored (build artifacts). CLI tests that import service code use `../dist/...`, so build before running those; tests importing from `../src/...` run via tsx without a build.

// Resolution adapter, deliberately NOT leftover code: store.ts's ~1700
// lines were fully redistributed into ./store/ (PR 26 of the refactoring
// roadmap — .claude/plans/can-we-do-a-warm-cocke.md). This file exists only
// because ESM / TypeScript's "Bundler" module resolution does not fall back
// from "./store.js" to "./store/index.js" for an extension-bearing
// specifier (unlike a bare "./store" import, which would resolve to a
// directory index) — so the existing `from "./store.js"` / `"../store.js"`
// imports across the frontend, and the `vi.mock("./store.js", ...)` test
// mocks, keep resolving unchanged. Same pattern as api.ts's own shim (PR 22)
// — see that file's doc comment for the full rationale. Wave 5's
// folder-taxonomy PR is where those specifiers get rewritten to point at
// ./store/index.js directly and this file drops.
export * from "./store/index.js";

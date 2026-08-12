// Resolution adapter, deliberately NOT leftover code: api.ts's ~2000 lines
// were fully redistributed into ./api/ (PR 22 of the refactoring roadmap —
// .claude/plans/can-we-do-a-warm-cocke.md). This file exists only because
// ESM / TypeScript's "Bundler" module resolution does not fall back from
// "./api.js" to "./api/index.js" for an extension-bearing specifier (unlike
// a bare "./api" import, which would resolve to a directory index) — so the
// ~100 existing `from "./api.js"` / `"../api.js"` imports across the
// frontend, and the several `vi.mock("./api.js", ...)` test mocks, keep
// resolving unchanged. Wave 5's folder-taxonomy PR is where those
// specifiers get rewritten to point at ./api/index.js directly and this
// file drops — see that PR's own note on every move being a real diff
// because of the mandatory .js suffix convention.
export * from "./api/index.js";

import { defineConfig } from "vitest/config";

// Frontend's unit-test setup. Started deliberately minimal (Phase 4d, pure
// logic modules only, e.g. reorder.ts) — the default environment stays
// "node" so those fast, DOM-free tests are unaffected. Component tests
// (issue #26 phase 5) opt into jsdom per-file via a `// @vitest-environment
// jsdom` docblock at the top of the file, rather than flipping this default
// and paying jsdom's setup cost for every test file. `setupFiles` registers
// jest-dom's matchers globally either way — harmless for non-DOM tests,
// since they never call a DOM-only matcher.
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./src/testSetup.ts"],
    // Force NODE_ENV=test regardless of the invoking shell. Vitest only
    // defaults the worker's NODE_ENV to "test" when it's *unset* (it uses
    // `process.env.NODE_ENV || "test"`), so a dev shell exporting
    // NODE_ENV=production leaks through. React's CJS entry then loads its
    // production build, which doesn't export `act`, and @testing-library/react
    // v16 crashes with "React.act is not a function" on every render/cleanup
    // (issue #114). Set via `test.env` (not a setup-file assignment) so it
    // lands in the worker's process.env at spawn, before react is imported —
    // a setup file runs too late, after ESM import hoisting has already
    // loaded react. Mirrors the backend's test/setup.ts guard added in #82
    // for the same class of dev-shell env leakage.
    env: { NODE_ENV: "test" },
    // Node 22+'s own built-in `globalThis.localStorage` (gated behind
    // --localstorage-file, which we never pass) shadows the working
    // jsdom-provided one vitest's jsdom environment sets up per test file,
    // so any module that touches localStorage at import time (store.ts)
    // throws "Cannot read properties of undefined" instead of using
    // jsdom's implementation. Disabling Node's own copy for the worker
    // processes running tests removes the conflict; the built-in flavor
    // is otherwise irrelevant here; jsdom's is what code under test needs.
    execArgv: ["--no-experimental-webstorage"],
  },
});

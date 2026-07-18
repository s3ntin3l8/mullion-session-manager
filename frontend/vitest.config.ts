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

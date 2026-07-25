import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
    // `frontend/` is its own npm workspace with its own vitest.config.ts
    // (run via `cd frontend && npm run test`, see CLAUDE.md's Makefile
    // table) — without this, Vitest's default broad `**/*.test.*` include
    // pattern also swept up frontend/src/*.test.ts(x) from here, running
    // them a second time against this root config/node_modules instead of
    // frontend's. That happened to stay silently harmless while every
    // frontend test file was pure-logic (no jsdom needed), but a
    // jsdom-requiring frontend component test fails outright from here
    // since jsdom is only installed in frontend/node_modules, not root.
    //
    // `.worktrees/` (issue #277's worktree-isolation feature) holds full,
    // separate checkouts of this same repo — each with its own `frontend/`
    // and `test/` trees — one per in-flight worktree session. Without this
    // exclusion, every one of those checkouts' test suites (backend AND
    // frontend) gets swept up and re-run a second time from this root
    // config too, multiplying run time per active worktree and hitting the
    // exact same frontend/jsdom failure mode above (that worktree's own
    // frontend/node_modules, not root's, is what has jsdom installed).
    exclude: [...configDefaults.exclude, "frontend/**", ".worktrees/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});

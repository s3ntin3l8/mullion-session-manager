import { defineConfig, configDefaults } from "vitest/config";
import { coverageConfig, worktreeExcludes } from "./vitest.shared.js";

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
    // The `.wt/`, `.claude/worktrees/`, and `.mullion-worktrees/` entries
    // (worktreeExcludes, see vitest.shared.ts for why each exists) exclude
    // full separate checkouts of this repo from being swept up the same
    // way — each hits the exact same frontend/jsdom failure mode above via
    // its own `frontend/` subtree.
    //
    // `test/e2e/` (issue #407) is a separate, opt-in suite with its own
    // vitest.e2e.config.ts (real Unix sockets, a real spawned CLI process, a
    // real Playwright Chromium) — it must NOT run as part of the default
    // `make test`/`npm test` gate, which every other file in this repo
    // assumes stays fast and dependency-free. Run it explicitly via
    // `make test-e2e` instead.
    exclude: [...configDefaults.exclude, "frontend/**", ...worktreeExcludes, "test/e2e/**"],
    coverage: coverageConfig,
  },
});

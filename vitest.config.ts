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
    exclude: [...configDefaults.exclude, "frontend/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});

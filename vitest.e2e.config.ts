import { defineConfig, configDefaults } from "vitest/config";
import { worktreeExcludes } from "./vitest.shared.js";

// Issue #407 — a separate, opt-in Vitest project for the Phase 4 socket
// API's manual verification checklist, turned into a repeatable suite: real
// buildApp() instances, real Unix control sockets, a real spawned mullion.mjs
// CLI process, and a real (unmocked) Playwright Chromium. Deliberately NOT
// the default vitest.config.ts (see that file's own `exclude` entry for
// "test/e2e/**"):
//
//   - It needs a real Chromium available (`npx playwright install chromium`
//     if `~/.cache/ms-playwright/` is empty) — `make test`/`npm test` must
//     never depend on that.
//   - It's meaningfully slower (real process spawns, real browser launches)
//     than the mocked unit/integration suite.
//   - It's opt-in, not run via `make test`/`npm test` — it IS run in CI as
//     its own dedicated `test-e2e` job (`.github/workflows/ci-cd.yml`,
//     issue #407), separate from the default suite for exactly the reasons
//     above; see test/e2e/README.md for the full "why a separate job"
//     rationale.
//
// Run via `make test-e2e` / `npm run test:e2e`.
export default defineConfig({
  test: {
    globals: true,
    setupFiles: ["./test/setup.ts"],
    include: ["test/e2e/**/*.e2e.test.ts"],
    // worktreeExcludes (see vitest.shared.ts) must stay in sync with
    // vitest.config.ts's own exclude list — both configs glob from the same
    // repo root and need to skip the same full separate checkouts.
    exclude: [...configDefaults.exclude, "frontend/**", ...worktreeExcludes],
    // A cold `chromium.launch()` (browser-actions.e2e.test.ts,
    // multi-host.e2e.test.ts) and a real spawned CLI child process
    // round-trip (cli.e2e.test.ts) both comfortably blow past Vitest's
    // default 5s test/hook timeout.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Two files independently launch a real Chromium instance
    // (browser-actions.e2e.test.ts, multi-host.e2e.test.ts) — run e2e files
    // sequentially rather than fanning out concurrent Chromium launches,
    // since this suite already trades speed for realism.
    fileParallelism: false,
  },
});

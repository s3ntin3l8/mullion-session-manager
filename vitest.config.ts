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
    // `.wt/` (issue #277's worktree-isolation feature) holds full,
    // separate checkouts of this same repo — each with its own `frontend/`
    // and `test/` trees — one per in-flight worktree session. Without this
    // exclusion, every one of those checkouts' test suites (backend AND
    // frontend) gets swept up and re-run a second time from this root
    // config too, multiplying run time per active worktree and hitting the
    // exact same frontend/jsdom failure mode above (that worktree's own
    // frontend/node_modules, not root's, is what has jsdom installed).
    // `.claude/worktrees/` is the same class of directory under a different
    // root (already gitignored via `.git/info/exclude`'s
    // `**/.claude/worktrees/` — an agent-isolation worktree location, not
    // this repo's own product feature) that was simply missing here too.
    //
    // `.mullion-worktrees/` is yet another instance of the exact same class
    // of directory — Mullion's OWN product feature (git-worktree.ts, see
    // CLAUDE.md's Worktrees section), also full separate checkouts of this
    // repo, also gitignored via `.git/info/exclude`, and also missing here
    // until this line: a live Task Master worktree (`.mullion-worktrees/
    // mullion-task-<id>`, e.g. while a task sits `claimed`) hits the exact
    // same jsdom-missing failure this comment already documents for `.wt/`
    // the moment `npm test`/`make test` runs from the primary checkout.
    //
    // `test/e2e/` (issue #407) is a separate, opt-in suite with its own
    // vitest.e2e.config.ts (real Unix sockets, a real spawned CLI process, a
    // real Playwright Chromium) — it must NOT run as part of the default
    // `make test`/`npm test` gate, which every other file in this repo
    // assumes stays fast and dependency-free. Run it explicitly via
    // `make test-e2e` instead.
    exclude: [
      ...configDefaults.exclude,
      "frontend/**",
      ".wt/**",
      ".claude/worktrees/**",
      ".mullion-worktrees/**",
      "test/e2e/**",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "coverage",
    },
  },
});

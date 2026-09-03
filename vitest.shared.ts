import type { CoverageOptions } from "vitest/node";

// Shared between the root `vitest.config.ts` and `frontend/vitest.config.ts`
// (a separate npm workspace, imported via a relative `../vitest.shared.js`
// path — see that file for why the extension is `.js` despite this being a
// `.ts` file). `npm run test:coverage` (CI's `test-node`/`test-frontend`
// `lint-and-test` jobs, via ci-cd.yml's `coverage-fail-under`) needs
// `json-summary`: the reusable ci-node.yml workflow's "Enforce coverage
// threshold" step reads `coverage/coverage-summary.json`'s
// `.total.lines.pct` and hard-fails ("coverage-fail-under is set but
// coverage-summary.json was not found") if that reporter is missing. `json`
// isn't required by the frontend job (it doesn't shard, so there's no
// per-shard `coverage-final.json` to merge) but is included there anyway for
// parity and in case sharding is added later; the backend job does shard
// and needs it to merge `test-shard` results in `test-merge`.
export const coverageConfig: CoverageOptions = {
  provider: "v8",
  reporter: ["text", "json-summary", "json", "html"],
  reportsDirectory: "coverage",
};

// Directories holding full, separate checkouts of this same repo that must
// never be swept up by a glob-based `include`/`exclude` running from the
// primary checkout (or from another worktree) — each has its own
// `node_modules` (frontend's has jsdom, root's doesn't) and its own test
// tree, so re-running another checkout's tests from here either duplicates
// work or fails outright on missing deps.
//
// - `.wt/` (issue #277's worktree-isolation feature, AGENTS.md's "two
//   worktree concepts" invariant) — developer workspaces for isolating
//   concurrent agent sessions. Gitignored at the repo level.
// - `.claude/worktrees/` — the same class of directory under a different
//   root (agent-isolation worktrees), gitignored via `.git/info/exclude`'s
//   `**/.claude/worktrees/`.
// - `.mullion-worktrees/` — Mullion's OWN product feature
//   (`src/services/git-worktree.ts`, AGENTS.md's "two worktree concepts"
//   invariant), also
//   full separate checkouts, also gitignored via `.git/info/exclude`: a live
//   Task Master worktree (`.mullion-worktrees/mullion-task-<id>`, e.g. while
//   a task sits `claimed`) hits the exact same failure mode the other two
//   entries exist to prevent, the moment `npm test`/`make test` runs from
//   the primary checkout.
//
// This list is the single source of truth — consumers (`vitest.config.ts`,
// `vitest.e2e.config.ts`) spread it into their own `exclude` array alongside
// whatever else they need excluded (e.g. `frontend/**`, which isn't listed
// here since it isn't a worktree — it's this repo's own frontend workspace).
export const worktreeExcludes = [".wt/**", ".claude/worktrees/**", ".mullion-worktrees/**"];

import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import { sharedTypescriptRules } from "./eslint.shared.js";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: sharedTypescriptRules,
  },
  {
    // src/hooks/*.mjs and *.js (issues #174/#175), src/mcp/*.mjs (issue
    // #271), and src/cli/*.mjs (Phase 4, #134) are plain JavaScript, not
    // TypeScript — see their own header comments for why (loaded directly
    // by an external agent's own hook runner/plugin loader/MCP client, or —
    // for src/cli/ — spawned as the `mullion` binary itself, must run
    // unmodified under both tsx-watched dev and the compiled dist/ build,
    // with no tsc step of their own). TS files get Node globals (process,
    // setTimeout, ...) resolved through typescript-eslint's project
    // service; plain JS files under eslint's own `recommended` config
    // don't have any environment assumed, so `no-undef` flags every Node
    // global unless declared explicitly here.
    files: [
      "src/hooks/**/*.mjs",
      "src/hooks/**/*.js",
      "src/mcp/**/*.mjs",
      "src/cli/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: {
      globals: {
        process: "readonly",
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        Buffer: "readonly",
        // Node 18+ globals, for any of these files that talks HTTP directly
        // (e.g. scripts/capture-screenshots.mjs's own seed calls; round 3's
        // ssh-agent-helper.mjs renewal loop bounding its own POST with a
        // timeout via AbortSignal.timeout()).
        fetch: "readonly",
        AbortSignal: "readonly",
        // Node 21+ globals — src/cli/ssh-agent-helper.mjs (issue #820,
        // PR6) is the first file here to need them: the laptop-side helper
        // dials /ws/agent-bridge with the WHATWG WebSocket builtin
        // (deliberately not the `ws` package — see that file's own header
        // comment on why), and URL to turn its persisted http(s) baseUrl
        // into a ws(s) one.
        WebSocket: "readonly",
        URL: "readonly",
      },
    },
  },
  {
    // `.wt/` (issue #277's worktree-isolation feature, CLAUDE.md's
    // Worktrees section — developer workspaces for isolating concurrent
    // agent sessions) holds full, separate checkouts of this same repo —
    // each with its own `src/` (and `frontend/`, already excluded above via
    // the unanchored "frontend/" pattern matching at any depth). Without
    // this, `eslint .` from root also re-lints every active worktree's own
    // backend source a second time — confirmed empirically to be the
    // majority of files linted with two worktrees present. Same rationale
    // as vitest.config.ts's identical `.wt/**` exclusion — this entry had
    // drifted out of sync with it under the stale name `.worktrees/`
    // (pre-dating the directory's rename to `.wt/`), which stopped
    // excluding anything real and let a live `.wt/*` worktree from a
    // concurrent agent session reproduce the exact "multiple candidate
    // TSConfigRootDirs" failure this whole ignores block exists to
    // prevent — the practical trigger for fixing it here. `.claude/
    // worktrees/` is the same class of directory under a different root
    // (already gitignored via `.git/info/exclude`'s
    // `**/.claude/worktrees/` — an agent-isolation worktree location, not
    // this repo's own product feature) that was simply missing from this
    // list; multiple concurrent ones present at once produced the same
    // failure. `.mullion-worktrees/` is yet another instance of the same
    // class of directory — Mullion's OWN product feature
    // (git-worktree.ts, CLAUDE.md's Worktrees section), also full separate
    // checkouts, also gitignored via `.git/info/exclude`, and also missing
    // here until now: a live Task Master worktree (e.g. a `claimed` task)
    // hits this exact same failure the moment `eslint .`/`make lint` runs
    // from the primary checkout.
    ignores: [
      "dist/",
      "node_modules/",
      "drizzle/",
      "coverage/",
      "frontend/",
      ".wt/",
      ".claude/worktrees/",
      ".mullion-worktrees/",
    ],
  },
);

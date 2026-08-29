import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Issue: Mullion's own agent-facing tooling (today just the `mullion-host`
// skill — a repo-agnostic pointer to the per-session agent guide copy, see
// src/bundle/skills/mullion-host/SKILL.md) currently only reaches an agent
// when the session's cwd happens to be THIS repo's own checkout
// (.claude/skills/mullion-agent-guide/). This module ships it into every
// Claude Code session, in every project, via `--plugin-dir` — "Load a
// plugin from a directory or .zip for this session only" (verified against
// the installed CLI: a hand-built `.claude-plugin/plugin.json` + `skills/`
// dir loads correctly, composes with the `--settings`/`--mcp-config` flags
// claude-code.ts's commandTransform already appends, and survives being
// passed twice — see the plan doc's spike table for the full verification).
//
// Resolution mirrors resolveMcpServerPath/resolveForwarderPath in
// shared.ts, not agent-guide.ts's cwd-relative resolveAgentGuideSourcePath:
// `src/bundle/` sits alongside `src/hooks/`/`src/mcp/`/`src/cli/` (all
// copied into `dist/` verbatim by package.json's build script, none of them
// compiled by tsc — see tsconfig.build.json's `src/**/*.ts` include), so it
// gets the same import.meta.url-relative + MULLION_HOME resolution those
// get, not docs/agent-guide.md's repo-root-relative one. Unlike the
// forwarder path (embedded in a Codex/agy managed config Mullion writes to
// the agent's OWN real config, where a changing path would re-trigger
// Codex's one-time `/hooks` trust prompt on every release — see shared.ts's
// resolveHooksDir comment), `--plugin-dir` is a per-launch CLI flag with no
// persisted, hash-checked identity, so there's no equivalent reason to
// prefer the stable `current` symlink over an ordinary MULLION_HOME
// resolution — it's used here anyway, for the same "identical across
// upgrades" reasoning and because it costs nothing.
function resolveBundleRootDir(): string {
  const mullionHome = process.env.MULLION_HOME?.trim();
  if (mullionHome) {
    return path.join(mullionHome, "current", "dist", "bundle");
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "..", "..", "bundle");
}

/**
 * The bundle directory to pass to `--plugin-dir`, or `null` if this
 * install/checkout hasn't shipped one (a stripped-down test fixture, or a
 * pre-this-issue release tarball rebuilt without a fresh `npm run build`) —
 * mirrors agentGuideSourceExists()'s "soft failure, never throw" contract
 * (agent-guide.ts). claude-code.ts's commandTransform checks this before
 * ever appending `--plugin-dir` — emitting a flag that points at a
 * directory that isn't there is worse than not emitting the flag at all.
 */
export function resolveMullionBundleDir(): string | null {
  const dir = resolveBundleRootDir();
  return existsSync(dir) ? dir : null;
}

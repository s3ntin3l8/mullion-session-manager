import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
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

// Every directory this module ever writes under a destRoot carries this
// prefix — installBundleSkills only ever creates `mullion-`-prefixed dirs,
// and uninstallBundleSkills only ever removes them, so neither can ever
// touch a skill a user or another tool placed there themselves.
const INSTALLED_SKILL_PREFIX = "mullion-";

/** Recursively syncs `sourceDir`'s files into `destDir`, creating `destDir`
 * (and any subdirectories) as needed, and skipping any file whose content
 * already matches — the "content-compare-then-skip" contract `managedInstall`
 * needs (agy.ts's `mergeAgyTrustedWorkspace` calls out why: this runs on
 * EVERY matching launch, not once, so a naive unconditional overwrite would
 * mean every session spawn touches these files' mtimes for no reason).
 * Never deletes a stale file that no longer exists in `sourceDir` — bundle
 * skills are small and don't currently shed files across releases; if that
 * ever changes, this needs a real "prune extras" pass, not a guess now. */
function syncSkillDir(sourceDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      syncSkillDir(sourcePath, destPath);
      continue;
    }
    const content = readFileSync(sourcePath);
    let existing: Buffer | null;
    try {
      existing = readFileSync(destPath);
    } catch {
      existing = null;
    }
    if (existing === null || !existing.equals(content)) {
      writeFileSync(destPath, content);
    }
  }
}

/**
 * Installs every skill in the shipped bundle (src/bundle/skills/<name>/)
 * into `destRoot/mullion-<name>/` — the zero-repo-change delivery vehicle
 * for codex and agy, neither of which has an ephemeral per-session overlay
 * (unlike Claude Code's `--plugin-dir` or opencode's `skills.paths`
 * config key — see claude-code.ts's commandTransform and opencode.ts's
 * prepareLaunch for those). `destRoot` differs per agent and is NOT
 * interchangeable: `~/.agents/skills` for codex (skills.ts's own global-scope
 * table), `~/.gemini/config/skills` for agy (its real customization root —
 * verified this session that agy does NOT load skills from `~/.agents/skills`
 * at all, only from a workspace-relative `.agents/skills` or this global
 * root; see the plan doc's S6 spike). A no-op (not an error) when this
 * install hasn't shipped a bundle (resolveMullionBundleDir() returns null)
 * or ships one with no skills/ directory at all. */
export function installBundleSkills(destRoot: string): void {
  const bundleDir = resolveMullionBundleDir();
  if (!bundleDir) return;
  const skillsDir = path.join(bundleDir, "skills");
  let skillNames: string[];
  try {
    skillNames = readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return;
  }
  for (const name of skillNames) {
    syncSkillDir(
      path.join(skillsDir, name),
      path.join(destRoot, `${INSTALLED_SKILL_PREFIX}${name}`),
    );
  }
}

/**
 * Removes every `mullion-`-prefixed directory this module has ever
 * installed under `destRoot` — the reversal of installBundleSkills, called
 * on every matching launch when `sessions.injectMullionBundle` is off, so a
 * managed install left behind by an earlier session with the setting on
 * doesn't linger forever once an operator turns it off (codex-trust.ts is
 * the precedent for a Mullion-owned host-level change staying reversible).
 * Only ever removes entries carrying the prefix — never enumerates or
 * touches anything else in `destRoot`, the same containment
 * installBundleSkills itself relies on. A no-op when `destRoot` doesn't
 * exist yet (nothing was ever installed).
 */
export function uninstallBundleSkills(destRoot: string): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(destRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(INSTALLED_SKILL_PREFIX)) {
      rmSync(path.join(destRoot, entry.name), { recursive: true, force: true });
    }
  }
}

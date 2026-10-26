import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeConfigDir } from "./claude-code.js";

// Issue #2091 — Claude Code's "Do you trust this folder?" dialog is a SEPARATE
// gate from the tool-permission prompts `--dangerously-skip-permissions`
// covers (verified live: a `skipPermissions` child in a fresh Task Master /
// `--isolate` worktree on a remote host sat at it until a human answered).
// agy (`mergeAgyTrustedWorkspace`) and codex (`buildCodexTrustFlag`) already
// pre-trust the session's cwd under the same `skipPermissions` gate; this is
// Claude Code's counterpart.
//
// What Claude Code does, read from the installed 2.1.310 binary and confirmed
// by the entry it wrote when a worktree session's dialog was accepted:
//   - trust is `projects[<key>].hasTrustDialogAccepted` in its global config
//     file, `<CLAUDE_CONFIG_DIR || ~>/.claude.json` (a non-empty legacy
//     `<configDir>/.config.json` wins when it exists);
//   - inside a git repo the key is the repo's root, and a WORKTREE resolves
//     to its main checkout (that is the key Claude itself records), so
//     trusting the checkout once covers every worktree cut from it;
//   - outside a repo, any trusted ancestor directory counts.
// The file is guarded by a proper-lockfile style `<file>.lock` directory
// (stale after 10 s) that live Claude processes take for every write, and
// they re-read the file under it — so writing under the same lock, via an
// atomic rename, cooperates with them.

const LOCK_STALE_MS = 10_000;

// The shape Claude gives a project entry it creates itself. It reads an
// existing entry as-is rather than merging defaults, so a new one carries all
// of it.
const DEFAULT_PROJECT_ENTRY = {
  allowedTools: [],
  mcpContextUris: [],
  mcpServers: {},
  enabledMcpjsonServers: [],
  disabledMcpjsonServers: [],
  hasTrustDialogAccepted: false,
  hasClaudeMdExternalIncludesApproved: false,
  hasClaudeMdExternalIncludesWarningShown: false,
};

interface ClaudeGlobalConfig {
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; [key: string]: unknown }>;
  [key: string]: unknown;
}

export type ClaudeTrustResult = "written" | "already-trusted" | "no-config" | "locked";

/** Claude Code's global config file: `<CLAUDE_CONFIG_DIR || ~>/.claude.json`
 * (`-custom-oauth` suffix when `CLAUDE_CODE_CUSTOM_OAUTH_URL` is set), unless
 * a non-empty legacy `<configDir>/.config.json` exists, which it prefers. */
export function resolveClaudeGlobalConfigPath(): string {
  const legacy = path.join(resolveClaudeConfigDir(), ".config.json");
  try {
    const st = statSync(legacy);
    if (st.isFile() && st.size > 0) return legacy;
  } catch {
    // no legacy file — the normal case
  }
  const suffix = process.env.CLAUDE_CODE_CUSTOM_OAUTH_URL ? "-custom-oauth" : "";
  return path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), `.claude${suffix}.json`);
}

function normalizeKey(p: string): string {
  const n = p.normalize("NFC");
  return process.platform === "win32" ? n.replaceAll("\\", "/") : n;
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

/** The directory Claude keys trust by for `cwd`: its git repo's main
 * checkout (a worktree resolves to the checkout it was cut from), or null
 * when `cwd` is not inside a git repo. */
function gitCheckoutRoot(cwd: string): string | null {
  try {
    const common = execFileSync("git", ["-C", cwd, "rev-parse", "--git-common-dir"], {
      encoding: "utf8",
      timeout: 1000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const commonDir = path.resolve(cwd, common);
    // A bare repo or a separate git dir has no `.git` to take the parent of;
    // treat it as "not a checkout" (the cwd itself is then what gets trusted,
    // which is at worst one extra entry if Claude keys it differently).
    return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  } catch {
    return null;
  }
}

function isTrusted(config: ClaudeGlobalConfig, key: string, ancestors: boolean): boolean {
  let dir = key;
  for (;;) {
    if (config.projects?.[dir]?.hasTrustDialogAccepted === true) return true;
    if (!ancestors) return false;
    const parent = normalizeKey(path.dirname(dir));
    if (parent === dir) return false;
    dir = parent;
  }
}

function readConfig(configPath: string): ClaudeGlobalConfig | null {
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${configPath} is not valid JSON, leaving it untouched`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${configPath} is not a JSON object, leaving it untouched`);
  }
  const config = parsed as ClaudeGlobalConfig;
  if (
    config.projects !== undefined &&
    (typeof config.projects !== "object" ||
      config.projects === null ||
      Array.isArray(config.projects))
  ) {
    throw new Error(`${configPath}'s projects is not an object, leaving it untouched`);
  }
  return config;
}

/** Takes Claude Code's `<file>.lock` directory lock; false when a live
 * holder has it. A lock older than Claude's own stale window is broken once. */
function takeLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(lockPath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      let ageMs: number;
      try {
        ageMs = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        continue; // released between the mkdir and the stat — try again
      }
      if (ageMs <= LOCK_STALE_MS) return false;
      try {
        rmdirSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

/**
 * Marks the Claude Code project that owns `rawCwd` as trusted, so an
 * unattended session there does not stop at the folder-trust dialog.
 *
 * Fully SYNCHRONOUS on purpose, and no retry: `managedInstall` runs as a
 * microtask right after the spawn (see applyHookAdapters), so only a write
 * that finishes before the first `await` beats the child's own startup read
 * of this file — the same race codex.ts documents. A lock held by a live
 * process means "give up" ("locked"): the dialog appears, as it did before.
 *
 * A missing config file is a no-op (Claude has never run on this host; its
 * onboarding comes first anyway). An unparseable or wrong-shaped one throws
 * and is left untouched, as agy's trust write does.
 */
export function mergeClaudeTrustedPath(
  rawCwd: string,
  configPath = resolveClaudeGlobalConfigPath(),
): ClaudeTrustResult {
  const cwd = realOrResolved(rawCwd);
  const checkout = gitCheckoutRoot(cwd);
  const key = normalizeKey(checkout ? realOrResolved(checkout) : cwd);
  // In a repo only the checkout's own entry counts; outside one, any trusted
  // ancestor does (what Claude's own check does).
  const ancestors = checkout === null;

  const first = readConfig(configPath);
  if (first === null) return "no-config";
  if (isTrusted(first, key, ancestors)) return "already-trusted";

  // Write through a symlinked config rather than replacing the link.
  const realConfig = realOrResolved(configPath);
  const lockPath = `${realConfig}.lock`;
  if (!takeLock(lockPath)) return "locked";
  try {
    // Re-read under the lock: a live Claude may have written since.
    const config = readConfig(configPath);
    if (config === null) return "no-config";
    if (isTrusted(config, key, ancestors)) return "already-trusted";
    const projects = config.projects ?? {};
    const existing = projects[key];
    const merged: ClaudeGlobalConfig = {
      ...config,
      projects: {
        ...projects,
        [key]: {
          ...DEFAULT_PROJECT_ENTRY,
          ...(typeof existing === "object" && existing !== null && !Array.isArray(existing)
            ? existing
            : {}),
          hasTrustDialogAccepted: true,
        },
      },
    };
    const mode = statSync(realConfig).mode & 0o777;
    const tmp = `${realConfig}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, { mode });
      renameSync(tmp, realConfig);
    } catch (err) {
      try {
        unlinkSync(tmp);
      } catch {
        // never created, or already renamed — nothing to clean up
      }
      throw err;
    }
    return "written";
  } finally {
    try {
      rmdirSync(lockPath);
    } catch {
      // already gone — nothing to release
    }
  }
}

import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { shellQuote, resolveForwarderShimSourcePath } from "./shared.js";

// Issue: dev/prod worktree collision on host-global agent hook configs.
//
// agy and Codex (agy.ts's mergeAgyHooks, codex.ts's mergeCodexHooks) both
// merge Mullion's hook registration into a HOST-GLOBAL, persistent config
// file (`~/.gemini/config/hooks.json`, `~/.codex/hooks.json`) shared by
// EVERY Mullion instance on the host — a production install and any number
// of `.wt/<slug>` dev worktrees running `make dev` all write into the same
// file. Embedding `resolveForwarderPath()`'s checkout-specific absolute
// path directly in that file (as both adapters used to) means whichever
// instance launched an agy/Codex session LAST wins, and if that instance
// was a dev worktree that later gets `git worktree remove`d, EVERY agy/
// Codex session on the host — including ones the production install
// launched — starts failing "Cannot find module" on its own PreToolUse
// hook. agy treats a non-zero PreToolUse exit as a hard tool-call abort, so
// this doesn't degrade gracefully: it silently breaks `run_command` for
// every project on the host.
//
// The fix: the value written into that host-global file is this module's
// `resolveForwarderShimPath()` — a FIXED, host-stable, checkout-independent
// location — never the live forwarder path. Each session instead resolves
// its OWN real forwarder at run time, from the `MULLION_FORWARDER_PATH`/
// `MULLION_FORWARDER_NODE` env vars launch-plan.ts injects per-session
// (same seam as MULLION_HOOK_SOCKET/MULLION_HOOK_TOKEN). A dev instance and
// the production install can then run agy/Codex sessions concurrently
// without clobbering each other, and `git worktree remove`ing a dev
// worktree can never dangle a host-global config again.
//
// The shim script itself (src/hooks/forwarder-shim.sh) is deliberately
// POSIX `sh`, not JS — it must be able to fail open (print the correct
// JSON decision, exit 0) even when node itself is missing, which a
// node-based shim structurally cannot do. See that file's own header
// comment for its full contract.

// resolveForwarderShimSourcePath() (imported above, from shared.ts) resolves
// the PACKAGED shim script's own source location — same dev(`src/`)/
// prod(`dist/`) resolution as resolveForwarderPath(). It's read ONCE,
// synchronously, by the CURRENTLY RUNNING instance to seed
// ensureForwarderShim()'s target file below — unlike resolveForwarderPath(),
// that source path is never itself persisted into a config file, so it
// carries none of the dangling-path risk this whole module exists to
// eliminate. Not to be confused with resolveForwarderShimPath() just below,
// the FIXED, host-stable location the shim is installed AT.

/** The fixed, host-stable, per-user location the shim is installed at —
 * outside every checkout and every versioned release directory, so it
 * survives both a `git worktree remove` and a release bump. Deliberately
 * NOT under `$MULLION_HOME` (dev instances never set it — the whole point
 * is that dev and prod resolve to the SAME constant) and deliberately NOT
 * honoring `$XDG_CONFIG_HOME`/`$XDG_STATE_HOME`: those routinely differ
 * between an interactive dev shell and the `systemd --user` unit running
 * the production install, which would defeat the one property this design
 * depends on — every writer producing the identical path. */
export function resolveForwarderShimPath(): string {
  return path.join(os.homedir(), ".mullion", "hooks", "mullion-forwarder-shim.sh");
}

// `m` flag: the version header is the SECOND line of the shim (after the
// `#!/bin/sh` shebang on line 1), so `^` must match the start of any line,
// not just the start of the whole string.
const SHIM_VERSION_HEADER = /^#\s*mullion-forwarder-shim\s+v(\d+)/m;
const CURRENT_SHIM_VERSION = 1;

function parseShimVersion(content: string): number | null {
  const match = SHIM_VERSION_HEADER.exec(content);
  if (!match) return null;
  const version = Number(match[1]);
  return Number.isInteger(version) ? version : null;
}

/** Installs (or updates) the forwarder shim at its fixed host-stable
 * location, idempotently and safely under concurrent writers.
 *
 * - No-ops when the on-disk copy already has identical content — the
 *   common case on every launch after the first, since every writer (any
 *   release, any dev worktree) produces byte-identical bytes for a given
 *   shim version.
 * - Never downgrades: if the on-disk shim's version header is NEWER than
 *   `CURRENT_SHIM_VERSION`, an older release must not stomp a newer one.
 * - Writes atomically (`<target>.<pid>.tmp` + `renameSync`, same directory
 *   so the rename is atomic) so a reader can never observe a torn file —
 *   the concurrent-write race is a real possibility (two Mullion instances
 *   launching agy sessions at once), and this makes it benign rather than
 *   merely rare.
 *
 * Read failures (permissions, a directory where the file should be) are
 * treated as "absent" and overwritten — same posture as agy.ts's/codex.ts's
 * own "a missing config is not an error" handling; a shim we can't verify
 * is a shim we should just replace. */
export function ensureForwarderShim(
  sourcePath: string = resolveForwarderShimSourcePath(),
  targetPath: string = resolveForwarderShimPath(),
): string {
  const content = readFileSync(sourcePath, "utf8");

  let existing: string | null;
  try {
    existing = readFileSync(targetPath, "utf8");
  } catch {
    existing = null;
  }

  if (existing !== null) {
    if (existing === content) return targetPath;
    const existingVersion = parseShimVersion(existing);
    if (existingVersion !== null && existingVersion > CURRENT_SHIM_VERSION) {
      // A newer release's shim is already installed — leave it alone.
      return targetPath;
    }
  }

  mkdirSync(path.dirname(targetPath), { recursive: true });
  const tmpPath = `${targetPath}.${process.pid}.tmp`;
  writeFileSync(tmpPath, content, { mode: 0o755 });
  renameSync(tmpPath, targetPath);
  return targetPath;
}

/** Builds the fallback JSON a fail-open path must print for `agent`+`kind`
 * — mirrors forwarder.mjs's own main() fallback (forwarder.mjs:107-123) and
 * the shim's own `_mullion_fallback()` exactly. Exported so tests can
 * assert the two never drift apart. */
export function forwarderFallbackJson(agent: string, kind: string): string {
  return agent === "agy" && kind === "PreToolUse" ? `{"decision":"allow"}` : `{}`;
}

/** Builds the shell command a host-global hook config (agy's `hooks.json`,
 * Codex's `hooks.json`) should invoke for `agent`+`kind` — the shim's fixed
 * path plus argv, with a `|| printf '<fallback>'` guard covering the one
 * failure mode the shim itself can't cover: the shim file being missing,
 * not executable, or `sh` itself failing to exec it. Both agy and Codex run
 * this string via `${SHELL:-/bin/sh} -lc "<command>"` (agy: documented;
 * Codex: verified against `codex-rs/hooks/src/engine/command_runner.rs`'s
 * `default_shell_command`), so the same guarded shape works for both.
 *
 * Single-quoted (via shellQuote, already used for Task Master prompt text
 * elsewhere in this adapter family) rather than JSON.stringify-double-
 * quoted like the pre-shim command strings: single quotes are the only
 * POSIX quoting form with no inner escapes and no `$`/backtick expansion,
 * and both the shim path (`os.homedir()`-derived) and the fallback JSON
 * (Mullion-authored, contains no `'`) are safe under it. */
export function forwarderHookCommand(
  agent: string,
  kind: string,
  shimPath: string = resolveForwarderShimPath(),
): string {
  const fallback = forwarderFallbackJson(agent, kind);
  return `${shellQuote(shimPath)} ${agent} ${kind}` + ` || printf '%s\\n' ${shellQuote(fallback)}`;
}

/** Exported for tests only. */
export const __testing = {
  resolveForwarderShimSourcePath,
  parseShimVersion,
  CURRENT_SHIM_VERSION,
};

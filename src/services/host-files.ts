// Issue #895 — the primitive PR-6 (scaffold Mullion integration as a PR,
// routes/project-setup.ts) needs and host-git.ts's own header says doesn't
// exist yet: "no existing primitive reads or writes arbitrary file content
// on a remote host." Split into its own sibling file rather than added to
// host-git.ts directly — host-git.ts's existing exports are all narrow git
// plumbing (status/base-ref/push/repo-ref); reading/writing arbitrary
// scaffold content is a distinct concern that happens to need the exact
// same `(app, hostId, cwd, ...)` -> `HostGitResult<T>` dispatch shape, so it
// reuses host-git.ts's own `viaRemote` rather than duplicating it.
import type { FastifyInstance } from "fastify";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { gitEnv } from "./git-env.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { viaRemote, type HostGitResult } from "./host-git.js";
import { resolveWithin } from "./safe-path.js";
import type { ScaffoldEntry } from "./mullion-scaffold.js";

export type HostFileMap = Record<string, string | undefined>;

/** Ensures `dirPath` is a real directory before a plain file write into it —
 * moved verbatim from routes/project-setup.ts (Hermes review, PR #896 round
 * 2): a same-slug re-preview that switches OFF `symlinkAgentsSkills` leaves
 * a stale symlink at exactly this path (from an earlier symlink-mode
 * preview); `mkdirSync(dirPath, {recursive:true})` on a path that already
 * exists as a symlink throws (ENOENT), so the plain-file write below never
 * even got a chance to run. Removing a stale symlink first mirrors the
 * reverse fix `writeEntriesLocally`'s own symlink branch already applies. */
function ensureRealDir(dirPath: string): void {
  try {
    if (lstatSync(dirPath).isSymbolicLink()) {
      rmSync(dirPath, { recursive: true, force: true });
    }
  } catch {
    // ENOENT — nothing there yet, mkdirSync below creates it fresh.
  }
  mkdirSync(dirPath, { recursive: true });
}

/** Reads `relPaths`' current content directly off `cwd`'s own local
 * filesystem — moved verbatim from routes/project-setup.ts's
 * readExistingFiles (unchanged behavior for the LOCAL_HOST_ID caller), and
 * reused as-is by routes/internal.ts's `/internal/read-files` handler for
 * the REMOTE case (that route runs on the agent's own process, so "local
 * filesystem" there means the agent's, which is exactly what this function
 * always reads regardless of which host's route called it).
 *
 * A path absent from the returned record (or mapped to `undefined`) means
 * "doesn't exist yet" — mullion-scaffold.ts's computeScaffold already
 * treats a missing key that way, so neither host's caller needs to special-
 * case the difference between "never read" and "read but absent". */
export function readFilesLocally(cwd: string, relPaths: string[]): HostFileMap {
  // Object.create(null) — CodeQL (js/remote-property-injection), same
  // reasoning as project-setup.ts's own readExistingFiles: relPath is used
  // as an object key below, and a null-prototype record means even a
  // `__proto__`/`constructor`-shaped key (already rejected upstream by
  // isValidScaffoldSlug/resolveWithin, but defense in depth regardless)
  // lands as an ordinary own property.
  const files: HostFileMap = Object.create(null);
  for (const relPath of relPaths) {
    const resolved = resolveWithin(cwd, relPath);
    try {
      files[relPath] = readFileSync(resolved, "utf8");
    } catch (err) {
      // A directory (or a symlink to one) can't be read as text, but the
      // caller still needs to know it EXISTS so a re-scaffold doesn't
      // clobber it — see mullion-scaffold.ts's own doc comment. Empty
      // string is a safe existence-only sentinel: computeScaffold never
      // actually reads this path's text content, only checks `!== undefined`.
      if ((err as NodeJS.ErrnoException).code === "EISDIR") {
        files[relPath] = "";
      }
      // Otherwise absent/unreadable — left out of the record entirely,
      // same "missing key = doesn't exist yet" convention as the rest of
      // this codebase's soft-failure reads.
    }
  }
  return files;
}

/** Writes `entries` (files and/or symlinks) directly onto `cwd`'s own local
 * filesystem, then stages every change in `cwd` via `git add -A` when
 * `stage` is set — moved verbatim from routes/project-setup.ts's
 * writeScaffoldEntries (unchanged behavior for the LOCAL_HOST_ID caller),
 * and reused as-is by routes/internal.ts's `/internal/write-files` handler
 * for the REMOTE case, for the identical reason readFilesLocally above is.
 *
 * Handles BOTH ScaffoldEntry variants identically on either host: a
 * `kind: "symlink"` entry creates a real symlink via `symlinkSync` — once a
 * write request reaches whichever host actually owns `cwd`, creating a
 * symlink there is exactly as safe and straightforward as writing a plain
 * file (same containment check, same host-local filesystem call), so there
 * is no reason to reject or no-op it for a remote host the way issue #895's
 * own scope note flagged as a possible outcome. The symlink's `target` is
 * written VERBATIM, never resolved or rewritten — computeScaffold
 * deliberately emits a relative target (mullion-scaffold.ts) so the link
 * still resolves correctly regardless of which host or checkout root it
 * lands in; normalizing it here would break that.
 *
 * `entry.target` is still CONTAINMENT-CHECKED before being written, even
 * though it's never resolved or rewritten — this endpoint is reachable over
 * the wire (routes/internal.ts's `/internal/write-files`, for a remote
 * host), unlike this function's pre-#895 form, which only ever received
 * entries computeScaffold itself produced. `resolveWithin` alone (on
 * `entry.path`) only proves the symlink's own LOCATION stays inside `cwd`;
 * it says nothing about where the symlink POINTS. A `target` that resolves
 * outside `cwd` (relative to the symlink's own directory, since that's how
 * a relative symlink target is interpreted when followed) is rejected the
 * same way an escaping `entry.path` already is — same PathEscapeError,
 * same "guard the sink, not just the caller" posture as skill-name.ts's own
 * header comment documents for this class of finding. */
export function writeEntriesLocally(
  cwd: string,
  entries: ScaffoldEntry[],
  opts?: { stage?: boolean },
): void {
  for (const entry of entries) {
    const targetPath = resolveWithin(cwd, entry.path);
    if (entry.kind === "symlink") {
      // Validation only — `entry.target` itself is never rewritten, see
      // this function's own doc comment above.
      resolveWithin(cwd, path.join(path.dirname(entry.path), entry.target));
      mkdirSync(path.dirname(targetPath), { recursive: true });
      // Hermes review, PR #896 round 1 — only skip the create when what's
      // already there is a symlink pointing at the EXACT target we'd
      // create anyway (content-compare-then-skip); anything else (a
      // directory, a stale symlink to a different target, a plain file) is
      // removed and replaced. See project-setup.ts's original comment
      // (pre-#895) for the full same-slug re-preview scenario this guards.
      let alreadyCorrect = false;
      try {
        alreadyCorrect = readlinkSync(targetPath) === entry.target;
      } catch {
        // Not a symlink (ENOENT: nothing there yet; EINVAL: a real file/
        // directory sits there instead) — fall through to remove+create.
      }
      if (!alreadyCorrect) {
        rmSync(targetPath, { recursive: true, force: true });
        symlinkSync(entry.target, targetPath);
      }
    } else {
      ensureRealDir(path.dirname(targetPath));
      writeFileSync(targetPath, entry.contents);
    }
  }
  if (opts?.stage) {
    // `git diff HEAD` never shows an untracked file, staged or not — every
    // scaffold entry is brand new (or a mirror the target repo never had
    // before), so without staging them first a subsequent diff would
    // silently return null for every single one. `git add -A` here is
    // purely to make an upcoming diff/preview complete; commitWipChanges
    // (apply) does its own equivalent staging pass regardless of what's
    // already staged — see that function's own doc comment.
    execFileSync("git", ["-C", cwd, "add", "-A"], { stdio: "pipe", env: gitEnv() });
  }
}

/**
 * `relPaths`' current content, read from `cwd` on whichever host owns it —
 * `readFilesLocally` directly for `LOCAL_HOST_ID`, `/internal/read-files`
 * (via `RemoteHostClient.readFiles`) otherwise. See `viaRemote` (host-
 * git.ts) for the shared HostGitResult error-mapping this dispatch reuses.
 */
export async function readHostFiles(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  relPaths: string[],
): Promise<HostGitResult<HostFileMap>> {
  if (hostId === LOCAL_HOST_ID) {
    return { ok: true, value: readFilesLocally(cwd, relPaths) };
  }
  return viaRemote(app, hostId, (client) => client.readFiles(cwd, relPaths));
}

/**
 * Writes `entries` into `cwd` on whichever host owns it, optionally staging
 * every change afterward (`opts.stage`, `git add -A`) — `writeEntriesLocally`
 * directly for `LOCAL_HOST_ID`, `/internal/write-files` (via
 * `RemoteHostClient.writeFiles`) otherwise. `stage` is a named, explicit
 * opt-in rather than baked unconditionally into every write (independent
 * review before this shipped): a primitive called "write files" that also
 * silently mutated the git index with no signal at the call site would be
 * a surprising side effect for any FUTURE caller that doesn't want it, even
 * though every CURRENT caller (routes/project-setup.ts's finishPreview) does.
 */
export async function writeHostFiles(
  app: FastifyInstance,
  hostId: string,
  cwd: string,
  entries: ScaffoldEntry[],
  opts?: { stage?: boolean },
): Promise<HostGitResult<void>> {
  if (hostId === LOCAL_HOST_ID) {
    writeEntriesLocally(cwd, entries, opts);
    return { ok: true, value: undefined };
  }
  return viaRemote(app, hostId, async (client) => {
    await client.writeFiles(cwd, entries, opts?.stage);
  });
}

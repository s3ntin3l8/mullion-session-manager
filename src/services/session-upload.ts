import crypto from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { MAX_UPLOAD_BYTES, UPLOAD_IMAGE_EXTENSIONS } from "../shared/constants.js";

// Issue #68: a pasted/attached image can't travel down the terminal's own
// byte stream (no Sixel/Kitty/iTerm2 support, and the CLI running in the PTY
// couldn't read inline image bytes off stdin even if it could parse them
// anyway) — the only thing that actually gets an image "into" a CLI like
// Claude Code is a file it can open by path. This writes the upload into the
// session's own cwd so it's already inside the CLI's workspace (no
// out-of-workspace read prompt) and returns that path for the frontend to
// inject into the terminal, exactly like a text paste.

// The browser-supplied Content-Type alone only picks a filename extension —
// it's never trusted for anything else. matchesMagicBytes below is the
// actual content check: the caller-declared mime must additionally match the
// file's own leading signature bytes before anything is written, so a client
// can't smuggle arbitrary content onto disk (e.g. HTML/script) under a
// `.png`/`.jpg` extension by lying about Content-Type.
const MIME_EXTENSIONS: Record<string, string> = UPLOAD_IMAGE_EXTENSIONS;

/**
 * True only when `buffer` actually starts with `mime`'s real file signature
 * — the content check backing MIME_EXTENSIONS' doc comment above. `mime`
 * must already be one of MIME_EXTENSIONS' keys (callers check
 * extensionForMime first); an unrecognized mime here reads as a mismatch,
 * not a pass.
 *
 * A literal `switch` on purpose, not a `Record<string, (buf) => boolean>`
 * keyed and invoked by `mime` — CodeQL flagged that shape as an
 * "unvalidated dynamic method call" (dispatch on a user-controlled name),
 * even though the only thing at stake was `?.()` on an unknown key. A
 * `switch` over literal cases has no dynamic dispatch for CodeQL to flag.
 */
export function matchesMagicBytes(buffer: Buffer, mime: string): boolean {
  switch (mime) {
    case "image/png":
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );
    case "image/jpeg":
      return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    case "image/gif":
      return (
        buffer.length >= 6 &&
        buffer.subarray(0, 3).toString("latin1") === "GIF" &&
        (buffer.subarray(3, 6).toString("latin1") === "87a" ||
          buffer.subarray(3, 6).toString("latin1") === "89a")
      );
    case "image/webp":
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
        buffer.subarray(8, 12).toString("latin1") === "WEBP"
      );
    default:
      return false;
  }
}

// Re-exported so existing importers keep their path; the value lives in
// shared/constants.ts because the frontend pre-checks it too.
export { MAX_UPLOAD_BYTES };

export const UPLOAD_SUBDIR = ".mullion-uploads";

export function extensionForMime(mime: string): string | null {
  return Object.hasOwn(MIME_EXTENSIONS, mime) ? (MIME_EXTENSIONS[mime] ?? null) : null;
}

/**
 * Writes `buffer` into `<cwd>/.mullion-uploads/<random>.<ext>` and returns
 * the absolute path. `mime` must be one of MIME_EXTENSIONS' keys and match
 * `buffer`'s real signature (callers check extensionForMime/matchesMagicBytes
 * before this runs). The filename is always server-generated — never derived
 * from caller input — so there's nothing for a traversal attempt to reach
 * outside the fixed upload subdirectory.
 *
 * `cwd` trust is caller-dependent, not this function's concern: the
 * primary's local route (routes/sessions.ts) passes a DB-persisted
 * project/session cwd, trusted at the same level as its own unrestricted
 * project-cwd model. The agent route (`POST /internal/uploads`,
 * routes/internal.ts) resolves and confines `cwd` to this host's own
 * PROJECTS_ROOTS via `resolveWithinRoots` *before* calling this function —
 * the same barrier `/internal/actions`, `/internal/dock`, and
 * `/internal/github-repo` already apply to a caller-supplied cwd (see that
 * function's doc comment). CodeQL flagged this route's original
 * unrestricted cwd as uncontrolled data reaching a real filesystem write —
 * unlike those read-only routes, and unlike `/internal/sessions`/
 * `/internal/ws/attach`'s exec-only use of cwd, `saveSessionUpload` actually
 * creates a directory and writes a file, so it needed the same containment
 * those read routes already had. What this function itself enforces
 * regardless of caller: a hard size cap (MAX_UPLOAD_BYTES, plus the route's
 * own bodyLimit), an image-only mime allow-list verified against the file's
 * actual bytes (not just a claimed Content-Type), and a server-generated
 * filename confined to the fixed `.mullion-uploads/` subdirectory.
 */
export function saveSessionUpload(
  cwd: string,
  buffer: Buffer,
  mime: string,
  retentionMs = 0,
): string {
  const ext = extensionForMime(mime);
  if (!ext) throw new Error(`Unsupported image type: ${mime}`);

  const uploadDir = ensureUploadDir(cwd, retentionMs);
  const filename = `${crypto.randomUUID()}${ext}`;
  const filePath = path.join(uploadDir, filename);
  writeFileSync(filePath, buffer);
  return filePath;
}

const MAX_UPLOAD_NAME_LENGTH = 100;

/**
 * Reduces a caller-supplied file name to a safe, shell-friendly basename:
 * directory components dropped, every character outside `[A-Za-z0-9._-]`
 * replaced with `_`, leading dots stripped (no hidden files, no `..`), and
 * the length capped while keeping the extension. The name part can be pasted
 * into a terminal without quoting (the directory part is the session's own
 * cwd and is not sanitized). Falls back to `file`.
 */
export function sanitizeUploadName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "");
  if (!cleaned) return "file";
  if (cleaned.length <= MAX_UPLOAD_NAME_LENGTH) return cleaned;
  const ext = path.extname(cleaned);
  // A very long "extension" is just more name — don't let it eat the budget.
  const keep = ext.length > 0 && ext.length <= 16 ? ext : "";
  return cleaned.slice(0, MAX_UPLOAD_NAME_LENGTH - keep.length) + keep;
}

/**
 * Generic-file counterpart to saveSessionUpload: writes `buffer` to
 * `<cwd>/.mullion-uploads/<uuid>/<sanitized-name>` and returns the absolute
 * path. No content-type allow-list, unlike the image path — nothing here
 * serves an upload back (the file browser's download route, routes/project-
 * files.ts, always sends an attachment with an opaque type), and the user
 * already has a shell in that same directory, so an arbitrary file here
 * grants nothing new. The
 * on-disk name is still server-controlled: `sanitizeUploadName` strips
 * everything but a plain basename, and the uuid directory keeps same-named
 * uploads from colliding while the CLI still sees the original file name.
 * The same containment, symlink, `.gitignore` and size-cap guarantees as
 * saveSessionUpload apply (the size cap is the routes' bodyLimit).
 */
export function saveSessionFileUpload(
  cwd: string,
  buffer: Buffer,
  originalName: string,
  retentionMs = 0,
): string {
  const uploadDir = ensureUploadDir(cwd, retentionMs);
  const fileDir = path.join(uploadDir, crypto.randomUUID());
  mkdirSync(fileDir);
  const filePath = path.resolve(fileDir, sanitizeUploadName(originalName));
  // Containment guard (also the CodeQL js/path-injection barrier): the
  // caller-supplied name must not resolve outside its own uuid directory,
  // even if sanitizeUploadName ever regressed.
  if (!filePath.startsWith(fileDir + path.sep)) throw new Error("Invalid upload file name");
  writeFileSync(filePath, buffer);
  return filePath;
}

const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
// Keyed by upload dir (one per project root / session cwd / task worktree),
// so capped with oldest-first eviction like the repo's other module-level
// Maps. Evicting only means one extra directory scan for that dir later.
const MAX_PRUNE_ENTRIES = 500;
const lastPrunedAt = new Map<string, number>();

/** `MULLION_UPLOAD_RETENTION_DAYS` as milliseconds (0 = pruning off). */
export function uploadRetentionMs(config: { MULLION_UPLOAD_RETENTION_DAYS: number }): number {
  return config.MULLION_UPLOAD_RETENTION_DAYS * 86_400_000;
}

/**
 * Issue #1637: removes direct children of `uploadDir` (a `<uuid>.<ext>` image
 * or a `<uuid>/` generic-file directory) whose mtime is older than `maxAgeMs`.
 * `.gitignore` is kept. Uses lstat/rmSync so a symlinked child is unlinked,
 * never followed. Never throws — pruning must not fail an upload. Runs at
 * most once per `PRUNE_INTERVAL_MS` per directory, so a multi-file drop scans
 * once. `maxAgeMs <= 0` disables it.
 */
export function pruneUploadDir(uploadDir: string, maxAgeMs: number, now = Date.now()): void {
  if (maxAgeMs <= 0) return;
  const last = lastPrunedAt.get(uploadDir);
  if (last !== undefined && now - last < PRUNE_INTERVAL_MS) return;
  // delete-then-set refreshes insertion order, so eviction drops the
  // least-recently-pruned dir.
  lastPrunedAt.delete(uploadDir);
  if (lastPrunedAt.size >= MAX_PRUNE_ENTRIES) {
    const oldest = lastPrunedAt.keys().next().value;
    if (oldest !== undefined) lastPrunedAt.delete(oldest);
  }
  lastPrunedAt.set(uploadDir, now);
  try {
    for (const entry of readdirSync(uploadDir)) {
      if (entry === ".gitignore") continue;
      const child = path.join(uploadDir, entry);
      try {
        if (now - lstatSync(child).mtimeMs > maxAgeMs) {
          rmSync(child, { recursive: true, force: true });
        }
      } catch {
        // Raced with another prune/removal — skip this entry.
      }
    }
  } catch {
    // Unreadable dir — leave it; the upload itself is what matters.
  }
}

/**
 * Resolves, validates and (if needed) creates `<cwd>/.mullion-uploads`, then
 * prunes stale entries when `retentionMs > 0`.
 */
function ensureUploadDir(cwd: string, retentionMs: number): string {
  const root = path.resolve(cwd);
  const uploadDir = path.resolve(root, UPLOAD_SUBDIR);
  // Containment guard (also the CodeQL js/path-injection barrier): the
  // upload dir must stay directly beneath the resolved cwd.
  if (!uploadDir.startsWith(root + path.sep)) throw new Error("Invalid upload directory");
  // lstat (not stat/existsSync): a symlinked `.mullion-uploads` must not be
  // followed (it could point the write anywhere), and a plain file at that
  // path must be a clear error rather than an opaque ENOTDIR/EEXIST 500.
  let isNewDir = false;
  try {
    if (!lstatSync(uploadDir).isDirectory()) throw uploadDirError();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    isNewDir = true;
    mkdirSync(uploadDir, { recursive: true });
    // Re-check: a symlink planted between the lstat above and the mkdir is
    // followed silently by `recursive: true`. Narrows (does not fully close)
    // the window; the dir is only ever written to with server-chosen names.
    if (!lstatSync(uploadDir).isDirectory()) throw uploadDirError();
  }
  if (isNewDir) {
    // Keeps a project's own git status clean of pasted-image litter — an
    // upload is transient input to the CLI, not a file the user meant to add
    // to their repo. `wx` (exclusive create) so a concurrent upload that
    // got here first is not clobbered and does not throw.
    try {
      writeFileSync(path.join(uploadDir, ".gitignore"), "*\n", { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  pruneUploadDir(uploadDir, retentionMs);
  return uploadDir;
}

function uploadDirError(): Error {
  return Object.assign(
    new Error(`${UPLOAD_SUBDIR} exists but is not a regular directory (symlink or file)`),
    { statusCode: 409 },
  );
}

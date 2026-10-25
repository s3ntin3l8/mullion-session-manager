// Project file editor — the host-agnostic filesystem half. routes/project-
// files.ts calls these directly for a LOCAL_HOST_ID project; routes/
// internal.ts's /internal/project-files/* calls the very same functions on a
// remote agent (after requireWithinRoots has vetted `cwd`), so both hosts
// enforce one containment/size/binary policy.
//
// Containment is lexical (resolveWithin) AND real-path based
// (realpathExistingPrefix): a symlinked DIRECTORY inside the project that
// points outside it must not be a way out, which the lexical check alone
// misses. A leaf symlink that stays inside the project is followed (an
// `.env -> .env.local` link is everyday practice) — we operate on its
// resolved real path, still opened with O_NOFOLLOW so a link swapped in
// after resolution fails with ELOOP instead of being silently followed.
//
// Writes are deliberately in place (open without O_TRUNC, mtime check,
// ftruncate, write), like writeAgentRule: that preserves the existing
// mode/owner/hardlinks of e.g. a 0600 `.env`, at the cost of not being
// crash-atomic. File contents are secrets-adjacent — never log them, and
// keep error messages to the project-relative path.
import {
  closeSync,
  constants as fsConstants,
  createReadStream,
  createWriteStream,
  fstatSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { expandHome } from "./project-config.js";
import { PathEscapeError, realpathExistingPrefix, resolveWithin } from "./safe-path.js";

export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_DIR_ENTRIES = 2000;

// Content is capped at 1 MiB of raw bytes, but it travels JSON-escaped (a
// newline is 2 bytes, a control char up to 6) — Fastify's 1 MiB default body
// limit would reject a file the panel just opened. Headroom, not a new cap:
// writeProjectFile still enforces the real limit.
export const PROJECT_FILE_BODY_LIMIT = 8 * 1024 * 1024;

export type ProjectFileErrorCode =
  | "escape"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "not_regular"
  | "symlink"
  | "too_large"
  | "binary"
  | "conflict"
  | "not_empty"
  | "invalid"
  | "not_allowlisted";

const HTTP_STATUS: Record<ProjectFileErrorCode, number> = {
  escape: 400,
  not_found: 404,
  is_directory: 400,
  not_directory: 400,
  not_regular: 400,
  symlink: 400,
  too_large: 413,
  binary: 415,
  conflict: 409,
  not_empty: 409,
  invalid: 400,
  not_allowlisted: 403,
};

export class ProjectFileError extends Error {
  readonly httpStatus: number;
  constructor(
    readonly code: ProjectFileErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ProjectFileError";
    this.httpStatus = HTTP_STATUS[code];
  }
}

export interface ProjectDirEntry {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  /** Symlinks only: what the link resolves to. "outside" covers both a
   * target beyond the project root and a dangling link — neither is
   * openable. */
  targetKind?: "file" | "dir" | "outside";
}

export interface ProjectDirListing {
  path: string;
  entries: ProjectDirEntry[];
  truncated: boolean;
}

export interface ProjectFileContent {
  path: string;
  content: string;
  size: number;
  mtimeMs: number;
  /** Project-relative path the requested path resolves to, set only when
   * the requested path is (or passes through) a symlink. */
  symlinkTarget?: string;
}

export interface ProjectFileWriteResult {
  size: number;
  mtimeMs: number;
}

interface Resolved {
  realRoot: string;
  /** Real (symlink-resolved) absolute path to operate on. */
  real: string;
  /** Normalised project-relative form of the REQUESTED path. */
  rel: string;
  symlinkTarget?: string;
}

function isInside(realRoot: string, candidate: string): boolean {
  return candidate === realRoot || candidate.startsWith(realRoot + path.sep);
}

function resolveInProject(root: string, relPath: string, allowRoot: boolean): Resolved {
  if (relPath.includes("\0") || path.isAbsolute(relPath) || (!allowRoot && relPath === "")) {
    throw new ProjectFileError("escape", `Invalid path "${relPath.replaceAll("\0", "")}"`);
  }
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new ProjectFileError("not_found", "Project directory not found");
  }
  let lexical: string;
  try {
    lexical = resolveWithin(root, relPath);
  } catch (err) {
    if (err instanceof PathEscapeError) {
      throw new ProjectFileError("escape", `Path "${relPath}" is outside the project`);
    }
    throw err;
  }
  const rel = path.relative(path.resolve(root), lexical);
  if (!allowRoot && rel === "") {
    throw new ProjectFileError("is_directory", "Path is the project root");
  }
  let real: string;
  try {
    real = realpathExistingPrefix(lexical);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new ProjectFileError("not_directory", `"${relPath}" is invalid`);
    if (code === "ELOOP") throw new ProjectFileError("symlink", `"${relPath}" has a symlink loop`);
    // EACCES/EPERM etc. propagate so the route can answer 503, not a
    // misleading "escape".
    throw err;
  }
  // Containment check written inline, on the very value that is returned
  // (the shape CodeQL's js/path-injection query recognises as a sanitizer —
  // same reasoning as safe-path.ts's resolveWithin), not delegated to a
  // helper it can't see through.
  const contained = path.resolve(real);
  if (contained !== realRoot && !contained.startsWith(realRoot + path.sep)) {
    throw new ProjectFileError("escape", `Path "${relPath}" resolves outside the project`);
  }
  const expectedReal = path.join(realRoot, rel);
  return {
    realRoot,
    real: contained,
    rel,
    symlinkTarget: contained !== expectedReal ? path.relative(realRoot, contained) : undefined,
  };
}

/** O_NOFOLLOW only guards the FINAL path component. Between resolving `real`
 * and open(2), a process inside the project could swap an intermediate
 * directory for a symlink to somewhere outside it. Where /proc is available
 * (Linux), re-resolve what we actually opened and fail closed if it left the
 * project. Elsewhere this is a no-op (residual, narrow window). */
function assertFdInside(fd: number, realRoot: string, rel: string): void {
  let opened: string;
  try {
    opened = realpathSync(`/proc/self/fd/${fd}`);
  } catch {
    return;
  }
  if (!isInside(realRoot, opened)) {
    throw new ProjectFileError("escape", `Path "${rel}" resolves outside the project`);
  }
}

function mapFsError(err: unknown, rel: string): never {
  if (err instanceof ProjectFileError) throw err;
  const code = (err as NodeJS.ErrnoException).code;
  switch (code) {
    case "ENOENT":
      throw new ProjectFileError("not_found", `"${rel}" not found`);
    case "ENOTDIR":
      throw new ProjectFileError("not_directory", `"${rel}" has a non-directory parent`);
    case "EISDIR":
      throw new ProjectFileError("is_directory", `"${rel}" is a directory`);
    case "ELOOP":
      throw new ProjectFileError("symlink", `"${rel}" changed to a symlink; refusing to follow`);
    case "ENXIO":
      throw new ProjectFileError("not_regular", `"${rel}" is not a regular file`);
    case "EEXIST":
      throw new ProjectFileError("conflict", `"${rel}" already exists`);
    case "ENOTEMPTY":
      throw new ProjectFileError("not_empty", `"${rel}" is not empty`);
    case "EINVAL":
      throw new ProjectFileError("invalid", `"${rel}" can't be moved there`);
    default:
      throw err;
  }
}

export function listProjectDir(root: string, relDir: string): ProjectDirListing {
  const { realRoot, real, rel } = resolveInProject(root, relDir, true);
  let dirents;
  try {
    dirents = readdirSync(real, { withFileTypes: true });
  } catch (err) {
    return mapFsError(err, rel);
  }
  const entries: ProjectDirEntry[] = dirents.map((d) => {
    const child = path.join(real, d.name);
    if (d.isSymbolicLink()) {
      let targetKind: ProjectDirEntry["targetKind"] = "outside";
      try {
        const target = realpathSync(child);
        if (isInside(realRoot, target)) {
          targetKind = statSync(target).isDirectory() ? "dir" : "file";
        }
      } catch {
        // dangling or unreadable link — stays "outside" (not openable)
      }
      return { name: d.name, kind: "symlink", size: 0, targetKind };
    }
    if (d.isDirectory()) return { name: d.name, kind: "dir", size: 0 };
    let size = 0;
    try {
      size = lstatSync(child).size;
    } catch {
      // raced with a delete — size is cosmetic
    }
    return { name: d.name, kind: "file", size };
  });
  const isDirLike = (e: ProjectDirEntry) =>
    e.kind === "dir" || (e.kind === "symlink" && e.targetKind === "dir");
  entries.sort((a, b) => {
    const da = isDirLike(a) ? 0 : 1;
    const db = isDirLike(b) ? 0 : 1;
    return da - db || a.name.localeCompare(b.name);
  });
  const truncated = entries.length > MAX_DIR_ENTRIES;
  return { path: rel, entries: truncated ? entries.slice(0, MAX_DIR_ENTRIES) : entries, truncated };
}

export function readProjectFile(root: string, relPath: string): ProjectFileContent {
  const { realRoot, real, rel, symlinkTarget } = resolveInProject(root, relPath, false);
  let fd: number;
  try {
    // O_NONBLOCK so opening a FIFO can't hang the request; the isFile()
    // check below then rejects it.
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return mapFsError(err, rel);
  }
  try {
    assertFdInside(fd, realRoot, rel);
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new ProjectFileError("is_directory", `"${rel}" is a directory`);
    if (!st.isFile()) throw new ProjectFileError("not_regular", `"${rel}" is not a regular file`);
    if (st.size > MAX_PROJECT_FILE_BYTES) {
      throw new ProjectFileError("too_large", `"${rel}" is over the 1 MiB edit limit`);
    }
    const buf = readFileSync(fd);
    if (buf.length > MAX_PROJECT_FILE_BYTES) {
      throw new ProjectFileError("too_large", `"${rel}" is over the 1 MiB edit limit`);
    }
    let content: string;
    try {
      if (buf.includes(0)) throw new Error("nul");
      content = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      throw new ProjectFileError("binary", `"${rel}" is not a UTF-8 text file`);
    }
    return { path: rel, content, size: buf.length, mtimeMs: st.mtimeMs, symlinkTarget };
  } catch (err) {
    return mapFsError(err, rel);
  } finally {
    closeSync(fd);
  }
}

/** Read-only read of a file OUTSIDE any project, e.g. an agent CLI's plan
 * under `~/.claude/plans`. `absPath` (absolute or `~/`-prefixed) must sit
 * inside one of `roots` (Settings `externalReadRoots`); the read itself is
 * delegated to readProjectFile with that root, so lexical + realpath
 * containment, O_NOFOLLOW, the size cap and the UTF-8 check are the exact
 * ones project files get. `path` in the result is the root-relative form.
 * A root of `/` or the home dir is ignored: far too broad for a "plan folder"
 * allowlist, whatever the settings say. */
export function readExternalFile(absPath: string, roots: string[]): ProjectFileContent {
  const expanded = expandHome(absPath);
  if (expanded.includes("\0") || !path.isAbsolute(expanded)) {
    throw new ProjectFileError("invalid", "Path must be absolute or start with ~/");
  }
  const target = path.resolve(expanded);
  const home = path.resolve(os.homedir());
  for (const configured of roots) {
    const root = path.resolve(expandHome(configured));
    if (root === path.parse(root).root || root === home) continue;
    if (!target.startsWith(root + path.sep)) continue;
    return readProjectFile(root, path.relative(root, target));
  }
  throw new ProjectFileError(
    "not_allowlisted",
    "This path is not in Settings -> Readable paths, so it can't be opened",
  );
}

export function writeProjectFile(
  root: string,
  relPath: string,
  content: string,
  opts: { expectedMtimeMs?: number; create?: boolean } = {},
): ProjectFileWriteResult {
  const byteLength = Buffer.byteLength(content, "utf8");
  if (byteLength > MAX_PROJECT_FILE_BYTES) {
    throw new ProjectFileError("too_large", "Content is over the 1 MiB edit limit");
  }
  const { realRoot, real, rel } = resolveInProject(root, relPath, false);
  // Flags are decided at the open, not via a prior existence check: create
  // is O_EXCL (a concurrent creator makes EEXIST -> conflict), update has no
  // O_CREAT (a missing file is not_found, never silently created).
  const flags =
    fsConstants.O_WRONLY |
    fsConstants.O_NOFOLLOW |
    fsConstants.O_NONBLOCK |
    (opts.create ? fsConstants.O_CREAT | fsConstants.O_EXCL : 0);
  let fd: number;
  try {
    fd = openSync(real, flags, 0o644);
  } catch (err) {
    return mapFsError(err, rel);
  }
  try {
    assertFdInside(fd, realRoot, rel);
    const before = fstatSync(fd);
    if (!before.isFile())
      throw new ProjectFileError("not_regular", `"${rel}" is not a regular file`);
    if (
      !opts.create &&
      opts.expectedMtimeMs !== undefined &&
      before.mtimeMs !== opts.expectedMtimeMs
    ) {
      throw new ProjectFileError("conflict", `"${rel}" changed on disk since it was loaded`);
    }
    ftruncateSync(fd, 0);
    writeFileSync(fd, content, "utf8");
    const after = fstatSync(fd);
    return { size: after.size, mtimeMs: after.mtimeMs };
  } catch (err) {
    return mapFsError(err, rel);
  } finally {
    closeSync(fd);
  }
}

interface EntryRef {
  realRoot: string;
  /** Normalised project-relative path of the entry itself. */
  rel: string;
  /** Absolute path: the entry's REAL parent directory + its own name. The
   * leaf is deliberately not resolved, so rename/delete act on a symlink as
   * a link instead of following it to its target. */
  abs: string;
}

/** Resolves a path for an operation on the ENTRY ITSELF (mkdir / rename /
 * delete): the parent directory gets the full lexical + realpath
 * containment of resolveInProject, the final component is kept as written
 * (a `basename`, so it can't carry a separator or `..`). */
function resolveEntry(root: string, relPath: string): EntryRef {
  // Reuses resolveInProject's lexical validation + containment on the whole
  // path first (rejects empty/absolute/NUL/`..` escapes, and the project
  // root itself), then re-resolves just the parent for the real directory.
  const lexical = resolveInProject(
    root,
    path.dirname(relPath) === "." ? "" : path.dirname(relPath),
    true,
  );
  const name = path.basename(relPath);
  if (relPath === "" || relPath.includes("\0") || path.isAbsolute(relPath)) {
    throw new ProjectFileError("escape", `Invalid path "${relPath.replaceAll("\0", "")}"`);
  }
  if (name === "" || name === "." || name === "..") {
    throw new ProjectFileError("escape", `Invalid path "${relPath}"`);
  }
  const rel = path.join(lexical.rel, name);
  return { realRoot: lexical.realRoot, rel, abs: path.join(lexical.real, name) };
}

/** Creates one directory. The parent must already exist (no `-p`), and an
 * existing entry of any kind at the path is a `conflict`. */
export function makeProjectDir(root: string, relPath: string): { path: string } {
  const entry = resolveEntry(root, relPath);
  try {
    mkdirSync(entry.abs);
  } catch (err) {
    return mapFsError(err, entry.rel);
  }
  return { path: entry.rel };
}

/** Removes a file or symlink (the link, never its target), or an EMPTY
 * directory. A non-empty directory is `not_empty` — a recursive delete from a
 * file-editor tree is too easy to fire by mistake. */
export function deleteProjectPath(root: string, relPath: string): { path: string } {
  const entry = resolveEntry(root, relPath);
  try {
    if (lstatSync(entry.abs).isDirectory()) rmdirSync(entry.abs);
    else unlinkSync(entry.abs);
  } catch (err) {
    return mapFsError(err, entry.rel);
  }
  return { path: entry.rel };
}

/** Renames/moves an entry within the project. The destination must not
 * exist and its parent must. A file or symlink is moved with link(2)+unlink(2):
 * link(2) returns EEXIST for a destination that exists at the moment of the
 * call (where lstat-then-rename(2) would leave a window and rename(2) would
 * silently replace it). It is NOT atomic as a whole — if unlink(2) of the
 * source then fails, the destination link is removed again so the entry never
 * ends up under two names. A directory can't be hard-linked, so it keeps a
 * check-then-rename; a destination created between the check and the rename
 * is replaced, a residual that is bounded to the user's own project (Node has
 * no renameat2/RENAME_NOREPLACE). A filesystem that refuses hard links
 * (EXDEV/EPERM/ENOTSUP/EMLINK) falls back to that same check-then-rename. */
export function renameProjectPath(root: string, fromRel: string, toRel: string): { path: string } {
  const from = resolveEntry(root, fromRel);
  const to = resolveEntry(root, toRel);
  let isDir: boolean;
  try {
    isDir = lstatSync(from.abs).isDirectory();
  } catch (err) {
    return mapFsError(err, from.rel);
  }
  try {
    if (!isDir) {
      try {
        linkSync(from.abs, to.abs);
        try {
          unlinkSync(from.abs);
        } catch (unlinkErr) {
          // Don't leave the entry under two names.
          try {
            unlinkSync(to.abs);
          } catch {
            // best effort — the original error is the one worth reporting
          }
          throw unlinkErr;
        }
        return { path: to.rel };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "EXDEV" && code !== "EPERM" && code !== "ENOTSUP" && code !== "EMLINK") {
          throw err;
        }
        // fall through to check-then-rename
      }
    }
    try {
      lstatSync(to.abs);
      throw new ProjectFileError("conflict", `"${to.rel}" already exists`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    // Residual race (see the doc comment): a destination created right here
    // is replaced. Accepted — it's the user's own project and Node has no
    // no-replace rename.
    renameSync(from.abs, to.abs);
  } catch (err) {
    return mapFsError(err, to.rel);
  }
  return { path: to.rel };
}

export const MAX_SEARCH_VISITED = 20_000;
export const MAX_SEARCH_RESULTS = 50;
// Directories a filename search never descends into: VCS internals, vendored
// dependencies, and this product's own worktree checkouts (a project's
// .mullion-worktrees/ would otherwise duplicate every file N times).
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules", ".mullion-worktrees"]);

export interface ProjectSearchResult {
  path: string;
}

export interface ProjectSearchListing {
  results: ProjectSearchResult[];
  /** The walk hit MAX_SEARCH_VISITED, so a match may exist that wasn't seen. */
  truncated: boolean;
}

const BOUNDARY = new Set(["/", ".", "-", "_", " "]);

/** Subsequence ("fuzzy") match of `query` in `text` (both already lower-case):
 * null if some query char can't be found in order, else a score where
 * consecutive runs and matches at the start of a path segment/word count for
 * more. Leftmost-greedy — good enough to rank a quick-open list. */
export function fuzzyScore(query: string, text: string): number | null {
  let score = 0;
  let pos = -1;
  let prevMatched = -2;
  for (const ch of query) {
    const idx = text.indexOf(ch, pos + 1);
    if (idx === -1) return null;
    score += 1;
    if (idx === prevMatched + 1) score += 5;
    if (idx === 0 || BOUNDARY.has(text[idx - 1])) score += 4;
    prevMatched = idx;
    pos = idx;
  }
  return score;
}

function scorePath(query: string, relPath: string): number | null {
  const lower = relPath.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  const inBase = fuzzyScore(query, base);
  const inFull = fuzzyScore(query, lower);
  if (inBase === null && inFull === null) return null;
  // A hit inside the file name outranks the same hit spread over the path;
  // shorter paths win ties.
  return Math.max((inBase ?? 0) * 2, inFull ?? 0) - lower.length * 0.05;
}

/** Fuzzy filename search under `root` (breadth-first, so shallow files are
 * seen first when the visit cap bites). Regular files only; symlinks are never
 * followed or listed. Dotfiles and gitignored files ARE searched — that's the
 * point for a `.env`. */
export async function searchProjectFiles(
  root: string,
  query: string,
  opts: { limit?: number; maxVisited?: number } = {},
): Promise<ProjectSearchListing> {
  const limit = opts.limit ?? MAX_SEARCH_RESULTS;
  const maxVisited = opts.maxVisited ?? MAX_SEARCH_VISITED;
  const q = query.trim().toLowerCase();
  if (q === "" || q.includes("\0")) return { results: [], truncated: false };
  const { real: start } = resolveInProject(root, "", true);
  const scored: Array<{ path: string; score: number }> = [];
  const queue: Array<{ abs: string; rel: string }> = [{ abs: start, rel: "" }];
  let visited = 0;
  let truncated = false;
  while (queue.length > 0 && !truncated) {
    const dir = queue.shift()!;
    let dirents;
    try {
      dirents = await readdir(dir.abs, { withFileTypes: true });
    } catch (err) {
      // A directory that vanished mid-walk, or one we may not read, is skipped:
      // failing a filename search over one unreadable subtree would be worse.
      // Anything else (we never descend symlinks, so not ELOOP) is unexpected
      // and surfaces instead of becoming a silently empty result.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES" || code === "EPERM")
        continue;
      throw err;
    }
    for (const d of dirents) {
      if (++visited > maxVisited) {
        truncated = true;
        break;
      }
      const rel = dir.rel === "" ? d.name : `${dir.rel}/${d.name}`;
      if (d.isDirectory()) {
        if (!SEARCH_SKIP_DIRS.has(d.name)) queue.push({ abs: path.join(dir.abs, d.name), rel });
      } else if (d.isFile()) {
        const score = scorePath(q, rel);
        if (score !== null) scored.push({ path: rel, score });
      }
    }
  }
  scored.sort(
    (a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1),
  );
  return { results: scored.slice(0, limit).map(({ path: p }) => ({ path: p })), truncated };
}

// ---------------------------------------------------------------------------
// Raw-byte transfer (upload / download). Unlike the text editor's read/write
// above — whole-file, UTF-8, 1 MiB — these stream: memory stays flat whatever
// the file size, and binary content is fine. They reuse the same containment
// (resolveInProject / resolveEntry, O_NOFOLLOW, assertFdInside).
// ---------------------------------------------------------------------------

export interface ProjectFileDownload {
  stream: Readable;
  size: number;
  /** Project-relative path the request resolved to. */
  path: string;
  /** Basename, for Content-Disposition. */
  name: string;
}

/** Opens a regular file for streaming. The fd is opened and vetted (O_NOFOLLOW,
 * assertFdInside, regular-file, size cap) BEFORE this returns, so every
 * refusal is a ProjectFileError thrown synchronously — the caller never has a
 * half-sent response to unwind. The returned stream owns the fd and closes it
 * on end, error or destroy. */
export function openProjectFileReadStream(
  root: string,
  relPath: string,
  maxBytes: number,
): ProjectFileDownload {
  const { realRoot, real, rel } = resolveInProject(root, relPath, false);
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return mapFsError(err, rel);
  }
  try {
    assertFdInside(fd, realRoot, rel);
    const st = fstatSync(fd);
    if (st.isDirectory()) throw new ProjectFileError("is_directory", `"${rel}" is a directory`);
    if (!st.isFile()) throw new ProjectFileError("not_regular", `"${rel}" is not a regular file`);
    if (st.size > maxBytes) {
      throw new ProjectFileError(
        "too_large",
        `"${rel}" is over the ${maxBytes} byte transfer limit`,
      );
    }
    // `path` is ignored when `fd` is given; autoClose (the default) closes it.
    const stream = createReadStream("", { fd, autoClose: true });
    return { stream, size: st.size, path: rel, name: path.basename(rel) };
  } catch (err) {
    closeSync(fd);
    return mapFsError(err, rel);
  }
}

/** Creates every missing folder of `relDir`, one level at a time, each through
 * resolveEntry so a symlinked parent can't lead out. An existing folder (or a
 * symlink to one that stays inside the project) is merged into; an existing
 * non-folder in the way is a `conflict`. */
function ensureProjectDirs(root: string, relDir: string): void {
  if (relDir === "" || relDir === ".") return;
  const parts = relDir.split("/").filter((p) => p !== "" && p !== ".");
  let acc = "";
  for (const part of parts) {
    acc = acc === "" ? part : `${acc}/${part}`;
    const entry = resolveEntry(root, acc);
    let st;
    try {
      st = lstatSync(entry.abs);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return mapFsError(err, entry.rel);
      try {
        mkdirSync(entry.abs);
      } catch (mkErr) {
        // A concurrent upload of a sibling file created it first — fine.
        if ((mkErr as NodeJS.ErrnoException).code !== "EEXIST") return mapFsError(mkErr, entry.rel);
      }
      continue;
    }
    if (st.isDirectory()) continue;
    if (st.isSymbolicLink()) {
      // resolveInProject re-checks containment of the link's target.
      const target = resolveInProject(root, entry.rel, true);
      try {
        if (statSync(target.real).isDirectory()) continue;
      } catch (err) {
        return mapFsError(err, entry.rel);
      }
    }
    throw new ProjectFileError("conflict", `"${entry.rel}" already exists and is not a folder`);
  }
}

/** Streams `source` into a NEW file at `relPath`. Never overwrites: the bytes
 * land in a temp file beside the target (`.mullion-part-<uuid>`) and are then
 * published with link(2), which fails with EEXIST for a target that exists at
 * that instant — so create-only holds even against a concurrent writer. The
 * temp file is always removed again (success, failure, client abort).
 * `maxBytes` is enforced on the bytes actually received, not on a header the
 * client controls. `mkdirs` creates missing parent folders (folder upload). */
export async function writeProjectFileFromStream(
  root: string,
  relPath: string,
  source: Readable,
  opts: { maxBytes: number; mkdirs?: boolean },
): Promise<{ path: string; size: number }> {
  if (opts.mkdirs) {
    const dir = path.dirname(relPath);
    ensureProjectDirs(root, dir === "." ? "" : dir);
  }
  const entry = resolveEntry(root, relPath);
  const tmpAbs = path.join(path.dirname(entry.abs), `.mullion-part-${randomUUID()}`);
  let fd: number;
  try {
    fd = openSync(
      tmpAbs,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    return mapFsError(err, entry.rel);
  }
  let received = 0;
  const cleanup = () => {
    try {
      unlinkSync(tmpAbs);
    } catch {
      // already gone (published via rename, or never created)
    }
  };
  try {
    try {
      assertFdInside(fd, entry.realRoot, entry.rel);
    } catch (err) {
      // Not yet handed to a stream, so nothing else will close it.
      closeSync(fd);
      throw err;
    }
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        received += chunk.length;
        if (received > opts.maxBytes) {
          cb(
            new ProjectFileError(
              "too_large",
              `"${entry.rel}" is over the ${opts.maxBytes} byte transfer limit`,
            ),
          );
          return;
        }
        cb(null, chunk);
      },
    });
    // createWriteStream owns the fd from here and closes it when done.
    await pipeline(source, counter, createWriteStream("", { fd, autoClose: true }));
    publishNewFile(tmpAbs, entry);
    return { path: entry.rel, size: received };
  } catch (err) {
    return mapFsError(err, entry.rel);
  } finally {
    cleanup();
  }
}

/** link(2) the finished temp file to its final name (EEXIST -> `conflict`).
 * A filesystem that refuses hard links falls back to check-then-rename, with
 * the same small residual window renameProjectPath documents. */
function publishNewFile(tmpAbs: string, entry: EntryRef): void {
  try {
    linkSync(tmpAbs, entry.abs);
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new ProjectFileError("conflict", `"${entry.rel}" already exists`);
    }
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EMLINK" && code !== "EXDEV") throw err;
  }
  try {
    lstatSync(entry.abs);
    throw new ProjectFileError("conflict", `"${entry.rel}" already exists`);
  } catch (err) {
    if (err instanceof ProjectFileError) throw err;
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  renameSync(tmpAbs, entry.abs);
}

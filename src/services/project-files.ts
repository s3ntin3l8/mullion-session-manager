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
  fstatSync,
  ftruncateSync,
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
import path from "node:path";
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
  | "invalid";

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
 * exist (rename(2) would silently replace a file); its parent must. The
 * existence check and the rename are not atomic — a destination created in
 * between would be replaced — which is acceptable inside one's own project. */
export function renameProjectPath(root: string, fromRel: string, toRel: string): { path: string } {
  const from = resolveEntry(root, fromRel);
  const to = resolveEntry(root, toRel);
  try {
    lstatSync(from.abs);
  } catch (err) {
    return mapFsError(err, from.rel);
  }
  try {
    lstatSync(to.abs);
    throw new ProjectFileError("conflict", `"${to.rel}" already exists`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") return mapFsError(err, to.rel);
  }
  try {
    renameSync(from.abs, to.abs);
  } catch (err) {
    return mapFsError(err, to.rel);
  }
  return { path: to.rel };
}

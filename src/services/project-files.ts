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
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { PathEscapeError, realpathExistingPrefix, resolveWithin } from "./safe-path.js";

export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_DIR_ENTRIES = 2000;

export type ProjectFileErrorCode =
  | "escape"
  | "not_found"
  | "is_directory"
  | "not_directory"
  | "not_regular"
  | "symlink"
  | "too_large"
  | "binary"
  | "conflict";

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
    throw new ProjectFileError("escape", `Cannot resolve "${relPath}"`);
  }
  if (!isInside(realRoot, real)) {
    throw new ProjectFileError("escape", `Path "${relPath}" resolves outside the project`);
  }
  const expectedReal = path.join(realRoot, rel);
  return {
    realRoot,
    real,
    rel,
    symlinkTarget: real !== expectedReal ? path.relative(realRoot, real) : undefined,
  };
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
  const { real, rel, symlinkTarget } = resolveInProject(root, relPath, false);
  let fd: number;
  try {
    // O_NONBLOCK so opening a FIFO can't hang the request; the isFile()
    // check below then rejects it.
    fd = openSync(real, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (err) {
    return mapFsError(err, rel);
  }
  try {
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
  const { real, rel } = resolveInProject(root, relPath, false);
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

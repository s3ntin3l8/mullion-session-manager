import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

// Bound both the returned folders and the work done in file-heavy directories.
const MAX_DIRECTORIES = 1000;
const MAX_SCANNED_ENTRIES = 10000;

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: { name: string; path: string }[];
  truncated: boolean;
}

/** A listing failure with the HTTP status the route should answer with. */
export class FsDirsError extends Error {
  constructor(
    public readonly statusCode: 400 | 403 | 404,
    message: string,
  ) {
    super(message);
    this.name = "FsDirsError";
  }
}

/**
 * Lists the sub-directories of `input` on THIS machine's filesystem. Shared by
 * the primary's `GET /api/fs/dirs` (hostId local) and the agent's
 * `GET /internal/fs/dirs` (the proxy target for a remote host's picker).
 * Throws FsDirsError for the expected failures; anything else is unexpected.
 */
export async function listLocalDirectories(
  input: string,
  showHidden: boolean,
): Promise<DirectoryListing> {
  const expanded =
    input === "~" ? homedir() : input.startsWith("~/") ? homedir() + input.slice(1) : input;
  if (!isAbsolute(expanded) || expanded.includes("\0")) {
    throw new FsDirsError(400, "Path must be an absolute path or start with ~/.");
  }

  try {
    // CodeQL js/path-injection (alert #517, moved here from src/routes/fs.ts): this API intentionally accepts
    // any absolute directory behind the same auth gate as session creation,
    // which can already run a command in an arbitrary cwd. Restricting it to
    // project roots would prevent browsing for new projects. realpath follows
    // symlinks and .. with filesystem semantics; the bounded listing below
    // returns directories only and never reads file contents. This intended
    // capability needs a GHAS dismissal, not a path-containment guard or an
    // inline suppression (the CodeQL workflow does not process those).
    const path = await realpath(expanded);
    const directories: { name: string; path: string }[] = [];
    let scanned = 0;
    let truncated = false;
    const dir = await opendir(path);
    for await (const entry of dir) {
      if (++scanned > MAX_SCANNED_ENTRIES || directories.length >= MAX_DIRECTORIES) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".") && !showHidden) continue;
      const childPath = join(path, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        // Follow directory links like normal navigation; broken links and
        // links to files never become names in the response.
        isDirectory = await stat(childPath).then(
          (info) => info.isDirectory(),
          () => false,
        );
      }
      if (isDirectory) directories.push({ name: entry.name, path: childPath });
    }
    directories.sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(path);
    return { path, parent: parent === path ? null : parent, directories, truncated };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new FsDirsError(404, "Directory does not exist.");
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new FsDirsError(403, "Directory is not readable.");
    }
    if (code === "ELOOP" || code === "ENAMETOOLONG" || code === "EINVAL") {
      throw new FsDirsError(400, "Directory path is invalid.");
    }
    throw error;
  }
}

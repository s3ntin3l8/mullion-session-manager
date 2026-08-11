import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export type ProjectDirIssue =
  | "missing"
  | "parent-missing"
  | "not-a-directory"
  | "parent-not-a-directory"
  | "symlink"
  | "unreadable"
  | "create-failed";

export class ProjectDirError extends Error {
  constructor(
    readonly issue: ProjectDirIssue,
    message: string,
  ) {
    super(message);
    this.name = "ProjectDirError";
  }
}

/** Non-mutating. Throws ProjectDirError for every state other than "exists
 * and is a directory" — routes.ts uses the `issue` discriminator to decide
 * whether `createProjectDir` may be attempted (only "missing" is
 * creatable) and to pick a `code` for the response body. */
export function assertProjectDir(absPath: string): void {
  let st;
  try {
    // statSync follows symlinks — a cwd that is a symlink to a real
    // directory is legitimate and is today's status quo; only the create
    // path (below) needs to distinguish a symlink from a real directory.
    st = statSync(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      assertParentExists(absPath);
      return;
    }
    if (code === "ENOTDIR") {
      throw new ProjectDirError(
        "parent-not-a-directory",
        `${absPath}'s parent is not a directory.`,
      );
    }
    throw new ProjectDirError("unreadable", `Cannot access ${absPath}: permission denied.`);
  }
  if (!st.isDirectory()) {
    throw new ProjectDirError("not-a-directory", `${absPath} exists but is not a directory.`);
  }
}

function assertParentExists(absPath: string): void {
  const parent = path.dirname(absPath);
  let st;
  try {
    st = statSync(parent);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ProjectDirError("parent-missing", `Parent directory ${parent} does not exist.`);
    }
    if (code === "ENOTDIR") {
      throw new ProjectDirError("parent-not-a-directory", `${parent} is not a directory.`);
    }
    throw new ProjectDirError("unreadable", `Cannot access ${parent}: permission denied.`);
  }
  if (!st.isDirectory()) {
    throw new ProjectDirError("parent-not-a-directory", `${parent} is not a directory.`);
  }
  throw new ProjectDirError("missing", `Directory ${absPath} does not exist.`);
}

/** Leaf-only, hardened directory creation (issue #604 / PR #612's
 * pre-planted-symlink threat model). Resolves the ENTIRE ancestor chain via
 * realpath before ever calling mkdirSync, then creates exactly the final
 * path component with a non-recursive mkdirSync — so no symlinked ancestor
 * is traversed at create time, and no directory tree beyond the leaf is
 * ever materialized. Returns `true` if this call created the directory,
 * `false` if it already existed (idempotent — a retried "create it" must
 * succeed, not error). Throws ProjectDirError for every failure mode. */
export function createProjectDir(absPath: string): boolean {
  const parent = path.dirname(absPath);
  if (parent === absPath) {
    throw new ProjectDirError("parent-missing", `${absPath} has no parent directory.`);
  }

  let realParent: string;
  try {
    realParent = realpathSync(parent);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ProjectDirError("parent-missing", `Parent directory ${parent} does not exist.`);
    }
    throw new ProjectDirError("unreadable", `Cannot access ${parent}: permission denied.`);
  }

  let parentStat;
  try {
    parentStat = statSync(realParent);
  } catch {
    throw new ProjectDirError("unreadable", `Cannot access ${parent}: permission denied.`);
  }
  if (!parentStat.isDirectory()) {
    throw new ProjectDirError("parent-not-a-directory", `${parent} is not a directory.`);
  }

  const target = path.join(realParent, path.basename(absPath));
  try {
    mkdirSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      // A pre-planted dangling symlink (e.g. `~/code/foo -> /etc/cron.d`
      // whose target doesn't exist) reads as plain ENOENT to statSync
      // above `assertProjectDir` calls, so without this lstat check we'd
      // "create" nothing and silently treat the symlink as our directory
      // — this is the actual attack this function exists to close.
      let leafStat;
      try {
        leafStat = lstatSync(target);
      } catch {
        throw new ProjectDirError("create-failed", `Could not create ${absPath}: ${code}.`);
      }
      if (leafStat.isSymbolicLink()) {
        throw new ProjectDirError(
          "symlink",
          `${absPath} is a symlink — refusing to create a directory through it.`,
        );
      }
      if (leafStat.isDirectory()) {
        return false;
      }
      throw new ProjectDirError("not-a-directory", `${absPath} exists but is not a directory.`);
    }
    if (code === "ENOENT") {
      throw new ProjectDirError("parent-missing", `Parent directory ${parent} does not exist.`);
    }
    throw new ProjectDirError("create-failed", `Could not create ${absPath}: ${code}.`);
  }

  // Post-create re-check (PR #612's TOCTOU-narrowing idiom). Belt-and-
  // braces here, not load-bearing the way it is in dock-config.ts: there,
  // mkdirSync({recursive:true}) silently no-ops on a symlink-to-existing-
  // directory, which is what makes that re-check necessary. Here the
  // non-recursive mkdirSync above returns EEXIST instead of no-oping, and
  // the EEXIST branch already refuses a symlink — this just narrows the
  // remaining swap-after-create window.
  let createdStat;
  try {
    createdStat = lstatSync(target);
  } catch {
    throw new ProjectDirError("create-failed", `Could not verify ${absPath} after creation.`);
  }
  if (!createdStat.isDirectory() || createdStat.isSymbolicLink()) {
    throw new ProjectDirError(
      "symlink",
      `${absPath} was swapped for a symlink immediately after creation — refusing to use it.`,
    );
  }
  return true;
}

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertProjectDir,
  createProjectDir,
  ProjectDirError,
} from "../../src/services/project-dir.js";

// Route-level tests (test/routes/projects.test.ts) exercise the contract
// through app.inject() but can't reach every branch here — EACCES/ELOOP and
// a mid-walk ENOTDIR need real filesystem permission/symlink setups that
// are impractical to construct through the HTTP layer. Same rationale as
// that file's own mkdtempSync-everywhere convention (CI EACCES corrupted
// assertions there once already).

const cleanupDirs: string[] = [];
function tmpDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    // A blocked-permission test dir can't be recursively removed until its
    // own mode is restored.
    fs.chmodSync(dir, 0o700);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function issueOf(fn: () => void): string {
  try {
    fn();
    throw new Error("expected ProjectDirError, got no throw");
  } catch (err) {
    if (!(err instanceof ProjectDirError)) throw err;
    return err.issue;
  }
}

describe("assertProjectDir", () => {
  it("does not throw for an existing directory", () => {
    const dir = tmpDir("assert-ok-");
    expect(() => assertProjectDir(dir)).not.toThrow();
  });

  it("does not throw for an existing directory reached through a symlink", () => {
    const base = tmpDir("assert-symlink-");
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    const link = path.join(base, "link");
    fs.symlinkSync(real, link, "dir");
    expect(() => assertProjectDir(link)).not.toThrow();
  });

  it("'not-a-directory' when the path exists as a regular file", () => {
    const base = tmpDir("assert-file-");
    const file = path.join(base, "f");
    fs.writeFileSync(file, "x");
    expect(issueOf(() => assertProjectDir(file))).toBe("not-a-directory");
  });

  it("'missing' when the leaf doesn't exist but the parent does", () => {
    const base = tmpDir("assert-missing-");
    expect(issueOf(() => assertProjectDir(path.join(base, "nope")))).toBe("missing");
  });

  it("'parent-missing' when neither the leaf nor its parent exist", () => {
    const base = tmpDir("assert-parent-missing-");
    expect(issueOf(() => assertProjectDir(path.join(base, "a", "b")))).toBe("parent-missing");
  });

  it("'parent-not-a-directory' when an ancestor is a regular file", () => {
    const base = tmpDir("assert-ancestor-file-");
    const file = path.join(base, "f");
    fs.writeFileSync(file, "x");
    expect(issueOf(() => assertProjectDir(path.join(file, "sub")))).toBe("parent-not-a-directory");
  });

  it("'unreadable' on EACCES", () => {
    const base = tmpDir("assert-eacces-");
    fs.chmodSync(base, 0);
    try {
      expect(issueOf(() => assertProjectDir(path.join(base, "leaf")))).toBe("unreadable");
    } finally {
      fs.chmodSync(base, 0o700);
    }
  });

  it("'unreadable' on ELOOP (a symlink cycle)", () => {
    const base = tmpDir("assert-eloop-");
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(issueOf(() => assertProjectDir(path.join(a, "x")))).toBe("unreadable");
  });
});

describe("createProjectDir", () => {
  it("creates the leaf and returns true", () => {
    const base = tmpDir("create-ok-");
    const target = path.join(base, "project");
    expect(createProjectDir(target)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
  });

  it("is idempotent against an already-existing directory (returns false)", () => {
    const base = tmpDir("create-existing-");
    const target = path.join(base, "project");
    fs.mkdirSync(target);
    expect(createProjectDir(target)).toBe(false);
  });

  it("only ever creates the leaf — a missing parent is rejected, not built", () => {
    const base = tmpDir("create-leaf-only-");
    const target = path.join(base, "a", "b");
    expect(issueOf(() => createProjectDir(target))).toBe("parent-missing");
    expect(fs.existsSync(path.join(base, "a"))).toBe(false);
  });

  it("'parent-not-a-directory' when the parent path is a regular file", () => {
    const base = tmpDir("create-parent-file-");
    const file = path.join(base, "f");
    fs.writeFileSync(file, "x");
    expect(issueOf(() => createProjectDir(path.join(file, "sub")))).toBe("parent-not-a-directory");
  });

  it("'symlink' for a dangling symlink at the target path, and never creates through it", () => {
    const base = tmpDir("create-dangling-symlink-");
    const target = path.join(base, "project");
    const missingRealTarget = path.join(base, "nowhere");
    fs.symlinkSync(missingRealTarget, target, "dir");
    expect(issueOf(() => createProjectDir(target))).toBe("symlink");
    expect(fs.existsSync(missingRealTarget)).toBe(false);
  });

  it("creates through a symlinked parent (a legitimate setup, e.g. a bind-mounted ~/code)", () => {
    const base = tmpDir("create-symlinked-parent-");
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    const link = path.join(base, "link");
    fs.symlinkSync(real, link, "dir");
    const target = path.join(link, "project");
    expect(createProjectDir(target)).toBe(true);
    // Created under the symlink's real target, and visible through both.
    expect(fs.existsSync(path.join(real, "project"))).toBe(true);
  });

  it("'unreadable' when the parent chain can't be traversed (EACCES)", () => {
    const base = tmpDir("create-eacces-");
    const blocked = path.join(base, "blocked");
    fs.mkdirSync(blocked);
    fs.chmodSync(blocked, 0);
    try {
      const target = path.join(blocked, "sub", "project");
      expect(issueOf(() => createProjectDir(target))).toBe("unreadable");
    } finally {
      fs.chmodSync(blocked, 0o700);
    }
  });

  it("'unreadable' on ELOOP (a symlink cycle) instead of creating anything", () => {
    const base = tmpDir("create-eloop-");
    const a = path.join(base, "a");
    const b = path.join(base, "b");
    fs.symlinkSync(b, a);
    fs.symlinkSync(a, b);
    expect(issueOf(() => createProjectDir(path.join(a, "project")))).toBe("unreadable");
  });

  it("'not-a-directory' when a regular file already sits at the target path", () => {
    const base = tmpDir("create-target-file-");
    const target = path.join(base, "project");
    fs.writeFileSync(target, "x");
    expect(issueOf(() => createProjectDir(target))).toBe("not-a-directory");
  });
});

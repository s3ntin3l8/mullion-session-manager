import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  ProjectFileError,
  MAX_PROJECT_FILE_BYTES,
  MAX_DIR_ENTRIES,
  listProjectDir,
  readProjectFile,
  readExternalFile,
  writeProjectFile,
  makeProjectDir,
  deleteProjectPath,
  renameProjectPath,
  searchProjectFiles,
  fuzzyScore,
} from "../../src/services/project-files.js";

function codeOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof ProjectFileError) return err.code;
    throw err;
  }
  return undefined;
}

describe("project-files service", () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-pf-root-"));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-pf-outside-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  describe("path containment", () => {
    it("rejects traversal, absolute and NUL paths", () => {
      expect(codeOf(() => readProjectFile(root, "../x"))).toBe("escape");
      expect(codeOf(() => readProjectFile(root, "a/../../x"))).toBe("escape");
      expect(codeOf(() => readProjectFile(root, "/etc/passwd"))).toBe("escape");
      expect(codeOf(() => readProjectFile(root, "a\0b"))).toBe("escape");
      expect(codeOf(() => readProjectFile(root, ""))).toBe("escape");
      expect(codeOf(() => listProjectDir(root, "../"))).toBe("escape");
    });

    it("rejects a symlinked directory that points outside the project", () => {
      fs.writeFileSync(path.join(outside, "secret"), "x");
      fs.symlinkSync(outside, path.join(root, "link"));
      expect(codeOf(() => readProjectFile(root, "link/secret"))).toBe("escape");
      expect(codeOf(() => listProjectDir(root, "link"))).toBe("escape");
      expect(codeOf(() => writeProjectFile(root, "link/new", "x", { create: true }))).toBe(
        "escape",
      );
    });

    it("rejects a leaf symlink that points outside the project", () => {
      fs.writeFileSync(path.join(outside, "secret"), "x");
      fs.symlinkSync(path.join(outside, "secret"), path.join(root, ".env"));
      expect(codeOf(() => readProjectFile(root, ".env"))).toBe("escape");
      expect(codeOf(() => writeProjectFile(root, ".env", "y"))).toBe("escape");
      expect(fs.readFileSync(path.join(outside, "secret"), "utf8")).toBe("x");
    });

    it("reports not_found when the project directory is gone", () => {
      expect(codeOf(() => listProjectDir(path.join(root, "nope"), ""))).toBe("not_found");
    });
  });

  describe("symlinks inside the project", () => {
    it("reads and writes through a leaf symlink, reporting the target", () => {
      fs.writeFileSync(path.join(root, ".env.local"), "A=1\n");
      fs.symlinkSync(".env.local", path.join(root, ".env"));
      const read = readProjectFile(root, ".env");
      expect(read.content).toBe("A=1\n");
      expect(read.symlinkTarget).toBe(".env.local");
      writeProjectFile(root, ".env", "A=2\n", { expectedMtimeMs: read.mtimeMs });
      expect(fs.readFileSync(path.join(root, ".env.local"), "utf8")).toBe("A=2\n");
      expect(fs.lstatSync(path.join(root, ".env")).isSymbolicLink()).toBe(true);
    });

    it("has no symlinkTarget for a plain file", () => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      expect(readProjectFile(root, "a.txt").symlinkTarget).toBeUndefined();
    });
  });

  describe("listProjectDir", () => {
    it("lists dotfiles, dirs first then alphabetical, with symlink kinds", () => {
      fs.mkdirSync(path.join(root, "zdir"));
      fs.mkdirSync(path.join(root, "real"));
      fs.writeFileSync(path.join(root, ".env"), "ab");
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      fs.symlinkSync("real", path.join(root, "dirlink"));
      fs.symlinkSync("a.txt", path.join(root, "filelink"));
      fs.symlinkSync(outside, path.join(root, "outlink"));
      fs.symlinkSync("missing", path.join(root, "dangling"));
      const listing = listProjectDir(root, "");
      expect(listing.path).toBe("");
      expect(listing.truncated).toBe(false);
      expect(listing.entries.map((e) => e.name)).toEqual([
        "dirlink",
        "real",
        "zdir",
        ".env",
        "a.txt",
        "dangling",
        "filelink",
        "outlink",
      ]);
      const byName = Object.fromEntries(listing.entries.map((e) => [e.name, e]));
      expect(byName[".env"]).toMatchObject({ kind: "file", size: 2 });
      expect(byName.real.kind).toBe("dir");
      expect(byName.dirlink).toMatchObject({ kind: "symlink", targetKind: "dir" });
      expect(byName.filelink).toMatchObject({ kind: "symlink", targetKind: "file" });
      expect(byName.outlink).toMatchObject({ kind: "symlink", targetKind: "outside" });
      expect(byName.dangling).toMatchObject({ kind: "symlink", targetKind: "outside" });
    });

    it("lists a subdirectory and a symlinked in-project directory", () => {
      fs.mkdirSync(path.join(root, "sub"));
      fs.writeFileSync(path.join(root, "sub", "f"), "");
      fs.symlinkSync("sub", path.join(root, "alias"));
      expect(listProjectDir(root, "sub").entries.map((e) => e.name)).toEqual(["f"]);
      expect(listProjectDir(root, "alias").entries.map((e) => e.name)).toEqual(["f"]);
    });

    it("truncates past the entry cap", () => {
      for (let i = 0; i < MAX_DIR_ENTRIES + 5; i++) fs.writeFileSync(path.join(root, `f${i}`), "");
      const listing = listProjectDir(root, "");
      expect(listing.truncated).toBe(true);
      expect(listing.entries).toHaveLength(MAX_DIR_ENTRIES);
    });

    it("maps missing and non-directory targets", () => {
      fs.writeFileSync(path.join(root, "f"), "");
      expect(codeOf(() => listProjectDir(root, "missing"))).toBe("not_found");
      expect(codeOf(() => listProjectDir(root, "f"))).toBe("not_directory");
    });
  });

  describe("readProjectFile", () => {
    it("reads text with size and mtime", () => {
      fs.writeFileSync(path.join(root, "a.txt"), "héllo");
      const r = readProjectFile(root, "a.txt");
      expect(r).toMatchObject({ path: "a.txt", content: "héllo", size: 6 });
      expect(r.mtimeMs).toBe(fs.statSync(path.join(root, "a.txt")).mtimeMs);
    });

    it("rejects directories, missing files, binary and oversized files", () => {
      fs.mkdirSync(path.join(root, "d"));
      fs.writeFileSync(path.join(root, "nul.bin"), Buffer.from([65, 0, 66]));
      fs.writeFileSync(path.join(root, "bad.bin"), Buffer.from([0xff, 0xfe, 0xfd]));
      fs.writeFileSync(path.join(root, "big"), "x".repeat(MAX_PROJECT_FILE_BYTES + 1));
      expect(codeOf(() => readProjectFile(root, "d"))).toBe("is_directory");
      expect(codeOf(() => readProjectFile(root, "missing"))).toBe("not_found");
      expect(codeOf(() => readProjectFile(root, "nul.bin"))).toBe("binary");
      expect(codeOf(() => readProjectFile(root, "bad.bin"))).toBe("binary");
      expect(codeOf(() => readProjectFile(root, "big"))).toBe("too_large");
      expect(codeOf(() => readProjectFile(root, "a.txt/x"))).toBe("not_found");
      fs.writeFileSync(path.join(root, "file"), "");
      expect(codeOf(() => readProjectFile(root, "file/x"))).toBe("not_directory");
    });

    it("rejects a FIFO without hanging", () => {
      const fifo = path.join(root, "fifo");
      try {
        execFileSync("mkfifo", [fifo]);
      } catch {
        return; // mkfifo unavailable on this platform
      }
      expect(codeOf(() => readProjectFile(root, "fifo"))).toBe("not_regular");
      expect(codeOf(() => writeProjectFile(root, "fifo", "x"))).toBe("not_regular");
    });
  });

  describe("writeProjectFile", () => {
    it("updates an existing file in place and returns fresh stat", () => {
      const file = path.join(root, "a.txt");
      fs.writeFileSync(file, "old content that is long");
      // One fd for every check, so nothing re-resolves the path between a
      // stat and a read (CodeQL js/file-system-race).
      const fd = fs.openSync(file, "r");
      try {
        const ino = fs.fstatSync(fd).ino;
        const res = writeProjectFile(root, "a.txt", "new");
        expect(fs.readFileSync(fd, "utf8")).toBe("new");
        const after = fs.fstatSync(fd);
        expect(after.ino).toBe(ino);
        expect(res).toEqual({ size: 3, mtimeMs: after.mtimeMs });
      } finally {
        fs.closeSync(fd);
      }
    });

    it("preserves the mode of a 0600 file", () => {
      const file = path.join(root, ".env");
      fs.writeFileSync(file, "A=1", { mode: 0o600 });
      fs.chmodSync(file, 0o600);
      writeProjectFile(root, ".env", "A=2");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    });

    it("does not create a missing file unless create is set", () => {
      expect(codeOf(() => writeProjectFile(root, "new.txt", "x"))).toBe("not_found");
      expect(fs.existsSync(path.join(root, "new.txt"))).toBe(false);
      writeProjectFile(root, "new.txt", "x", { create: true });
      expect(fs.readFileSync(path.join(root, "new.txt"), "utf8")).toBe("x");
    });

    it("refuses to create over an existing file and leaves it untouched", () => {
      fs.writeFileSync(path.join(root, "a.txt"), "keep");
      expect(codeOf(() => writeProjectFile(root, "a.txt", "x", { create: true }))).toBe("conflict");
      expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("keep");
    });

    it("does not create missing parent directories", () => {
      expect(codeOf(() => writeProjectFile(root, "no/dir/f", "x", { create: true }))).toBe(
        "not_found",
      );
    });

    it("detects an mtime conflict before truncating", () => {
      const file = path.join(root, "a.txt");
      fs.writeFileSync(file, "disk");
      const { mtimeMs } = readProjectFile(root, "a.txt");
      expect(
        codeOf(() => writeProjectFile(root, "a.txt", "mine", { expectedMtimeMs: mtimeMs - 1000 })),
      ).toBe("conflict");
      expect(fs.readFileSync(file, "utf8")).toBe("disk");
      writeProjectFile(root, "a.txt", "mine", { expectedMtimeMs: mtimeMs });
      expect(fs.readFileSync(file, "utf8")).toBe("mine");
    });

    it("rejects oversized content, directories and a non-directory parent", () => {
      fs.mkdirSync(path.join(root, "d"));
      fs.writeFileSync(path.join(root, "f"), "");
      expect(
        codeOf(() =>
          writeProjectFile(root, "a", "x".repeat(MAX_PROJECT_FILE_BYTES + 1), { create: true }),
        ),
      ).toBe("too_large");
      expect(codeOf(() => writeProjectFile(root, "d", "x"))).toBe("is_directory");
      expect(codeOf(() => writeProjectFile(root, "f/x", "x", { create: true }))).toBe(
        "not_directory",
      );
    });
  });

  describe("makeProjectDir", () => {
    it("creates a directory, requires an existing parent, conflicts on existing", () => {
      expect(makeProjectDir(root, "a")).toEqual({ path: "a" });
      expect(fs.statSync(path.join(root, "a")).isDirectory()).toBe(true);
      expect(makeProjectDir(root, "a/b")).toEqual({ path: "a/b" });
      expect(codeOf(() => makeProjectDir(root, "a"))).toBe("conflict");
      expect(codeOf(() => makeProjectDir(root, "x/y/z"))).toBe("not_found");
      fs.writeFileSync(path.join(root, "f"), "");
      expect(codeOf(() => makeProjectDir(root, "f"))).toBe("conflict");
      expect(codeOf(() => makeProjectDir(root, "f/sub"))).toBe("not_directory");
    });

    it("refuses escapes and the project root", () => {
      fs.symlinkSync(outside, path.join(root, "link"));
      for (const p of ["../x", "/abs", "a\0b", "", ".", "a/..", "link/new"]) {
        expect(
          codeOf(() => makeProjectDir(root, p)),
          p,
        ).toBe("escape");
      }
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  describe("deleteProjectPath", () => {
    it("deletes a file and an empty folder, but not a non-empty folder", () => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      fs.mkdirSync(path.join(root, "empty"));
      fs.mkdirSync(path.join(root, "full"));
      fs.writeFileSync(path.join(root, "full", "f"), "");
      expect(deleteProjectPath(root, "a.txt")).toEqual({ path: "a.txt" });
      expect(deleteProjectPath(root, "empty")).toEqual({ path: "empty" });
      expect(codeOf(() => deleteProjectPath(root, "full"))).toBe("not_empty");
      expect(fs.existsSync(path.join(root, "full", "f"))).toBe(true);
      expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
      expect(codeOf(() => deleteProjectPath(root, "a.txt"))).toBe("not_found");
    });

    it("deletes a symlink itself and never its target (even outside the project)", () => {
      fs.writeFileSync(path.join(outside, "keep"), "x");
      fs.symlinkSync(path.join(outside, "keep"), path.join(root, "out-link"));
      fs.writeFileSync(path.join(root, "real"), "r");
      fs.symlinkSync("real", path.join(root, "in-link"));
      deleteProjectPath(root, "out-link");
      deleteProjectPath(root, "in-link");
      expect(fs.existsSync(path.join(root, "out-link"))).toBe(false);
      expect(fs.lstatSync(path.join(root, "real")).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(outside, "keep"), "utf8")).toBe("x");
    });

    it("refuses escapes, the root, and paths through an outside symlinked dir", () => {
      fs.writeFileSync(path.join(outside, "secret"), "x");
      fs.symlinkSync(outside, path.join(root, "dirlink"));
      for (const p of ["../x", "/abs", "", ".", "..", "dirlink/secret"]) {
        expect(
          codeOf(() => deleteProjectPath(root, p)),
          p,
        ).toBe("escape");
      }
      expect(fs.existsSync(path.join(outside, "secret"))).toBe(true);
    });
  });

  describe("renameProjectPath", () => {
    it("renames a file and a folder, and moves across folders", () => {
      fs.writeFileSync(path.join(root, "a.txt"), "x");
      fs.mkdirSync(path.join(root, "d"));
      expect(renameProjectPath(root, "a.txt", "b.txt")).toEqual({ path: "b.txt" });
      expect(renameProjectPath(root, "b.txt", "d/c.txt")).toEqual({ path: "d/c.txt" });
      expect(fs.readFileSync(path.join(root, "d", "c.txt"), "utf8")).toBe("x");
      expect(renameProjectPath(root, "d", "e")).toEqual({ path: "e" });
      expect(fs.existsSync(path.join(root, "e", "c.txt"))).toBe(true);
    });

    it("never replaces an existing destination", () => {
      fs.writeFileSync(path.join(root, "a"), "A");
      fs.writeFileSync(path.join(root, "b"), "B");
      expect(codeOf(() => renameProjectPath(root, "a", "b"))).toBe("conflict");
      expect(fs.readFileSync(path.join(root, "b"), "utf8")).toBe("B");
    });

    it("conflicts on any existing destination, including a folder or a dangling symlink", () => {
      fs.writeFileSync(path.join(root, "a"), "A");
      fs.mkdirSync(path.join(root, "d"));
      fs.symlinkSync("nowhere", path.join(root, "dangling"));
      expect(codeOf(() => renameProjectPath(root, "a", "d"))).toBe("conflict");
      expect(codeOf(() => renameProjectPath(root, "a", "dangling"))).toBe("conflict");
      expect(fs.readFileSync(path.join(root, "a"), "utf8")).toBe("A");
      expect(fs.lstatSync(path.join(root, "dangling")).isSymbolicLink()).toBe(true);
    });

    it("maps missing source, missing destination folder, and moving a folder into itself", () => {
      fs.mkdirSync(path.join(root, "d"));
      fs.writeFileSync(path.join(root, "a"), "");
      expect(codeOf(() => renameProjectPath(root, "nope", "x"))).toBe("not_found");
      expect(codeOf(() => renameProjectPath(root, "a", "missing/a"))).toBe("not_found");
      expect(codeOf(() => renameProjectPath(root, "d", "d/inner"))).toBe("invalid");
    });

    it("renames a symlink as a link and refuses escapes on either side", () => {
      fs.writeFileSync(path.join(root, "real"), "r");
      fs.symlinkSync("real", path.join(root, "link"));
      renameProjectPath(root, "link", "link2");
      expect(fs.lstatSync(path.join(root, "link2")).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(root, "real"), "utf8")).toBe("r");

      fs.symlinkSync(outside, path.join(root, "dirlink"));
      expect(codeOf(() => renameProjectPath(root, "real", "../real"))).toBe("escape");
      expect(codeOf(() => renameProjectPath(root, "real", "dirlink/real"))).toBe("escape");
      expect(codeOf(() => renameProjectPath(root, "../x", "y"))).toBe("escape");
      expect(codeOf(() => renameProjectPath(root, "dirlink/zzz", "y"))).toBe("escape");
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  describe("fuzzyScore", () => {
    it("matches subsequences in order and rejects the rest", () => {
      expect(fuzzyScore("abc", "a_b_c")).not.toBeNull();
      expect(fuzzyScore("abc", "acb")).toBeNull();
      expect(fuzzyScore("x", "abc")).toBeNull();
    });

    it("scores consecutive runs and word-start hits higher", () => {
      expect(fuzzyScore("ind", "index.ts")!).toBeGreaterThan(fuzzyScore("ind", "a_i_n_d")!);
      expect(fuzzyScore("ts", "a-ts")!).toBeGreaterThan(fuzzyScore("ts", "atxs")!);
    });
  });

  describe("searchProjectFiles", () => {
    const touch = (rel: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), "");
    };

    it("finds dotfiles and nested files, ranking file-name hits first", async () => {
      touch(".env");
      touch("src/deep/environment.ts");
      touch("src/index.ts");
      touch("docs/readme.md");
      const res = await searchProjectFiles(root, "env");
      expect(res.truncated).toBe(false);
      expect(res.results.map((r) => r.path)).toEqual([".env", "src/deep/environment.ts"]);
    });

    it("is case-insensitive and returns nothing for an empty or unmatched query", async () => {
      touch("README.md");
      expect((await searchProjectFiles(root, "readme")).results).toHaveLength(1);
      expect((await searchProjectFiles(root, "   ")).results).toEqual([]);
      expect((await searchProjectFiles(root, "zzz")).results).toEqual([]);
      expect((await searchProjectFiles(root, "a\0b")).results).toEqual([]);
    });

    it("skips .git, node_modules and .mullion-worktrees, and never follows symlinks", async () => {
      touch(".git/config");
      touch("node_modules/pkg/config.js");
      touch(".mullion-worktrees/feat/config.yml");
      touch("config.toml");
      fs.writeFileSync(path.join(outside, "config.secret"), "");
      fs.symlinkSync(outside, path.join(root, "linkdir"));
      fs.symlinkSync(path.join(outside, "config.secret"), path.join(root, "config.link"));
      const res = await searchProjectFiles(root, "config");
      expect(res.results.map((r) => r.path)).toEqual(["config.toml"]);
    });

    it("caps results and reports truncation when the visit cap is hit", async () => {
      for (let i = 0; i < 12; i++) touch(`f${i}.txt`);
      const capped = await searchProjectFiles(root, "f", { limit: 5 });
      expect(capped.results).toHaveLength(5);
      const visited = await searchProjectFiles(root, "f", { maxVisited: 3 });
      expect(visited.truncated).toBe(true);
    });

    it("rejects a missing project directory", async () => {
      await expect(searchProjectFiles(path.join(root, "nope"), "a")).rejects.toMatchObject({
        code: "not_found",
      });
    });
  });

  it("exposes http statuses per error code", () => {
    expect(new ProjectFileError("conflict", "x").httpStatus).toBe(409);
    expect(new ProjectFileError("too_large", "x").httpStatus).toBe(413);
    expect(new ProjectFileError("binary", "x").httpStatus).toBe(415);
    expect(new ProjectFileError("not_found", "x").httpStatus).toBe(404);
    expect(new ProjectFileError("not_empty", "x").httpStatus).toBe(409);
    expect(new ProjectFileError("invalid", "x").httpStatus).toBe(400);
  });

  describe("readExternalFile", () => {
    it("reads inside an allowlisted root, with ~ expansion", () => {
      fs.mkdirSync(path.join(outside, "plans"));
      fs.writeFileSync(path.join(outside, "plans", "p.md"), "# plan");
      const roots = [path.join(outside, "plans")];
      const got = readExternalFile(path.join(outside, "plans", "p.md"), roots);
      expect(got.content).toBe("# plan");
      expect(got.path).toBe("p.md");

      const home = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-pf-home-"));
      const prev = process.env.HOME;
      process.env.HOME = home;
      try {
        fs.mkdirSync(path.join(home, ".claude", "plans"), { recursive: true });
        fs.writeFileSync(path.join(home, ".claude", "plans", "x.md"), "hi");
        expect(readExternalFile("~/.claude/plans/x.md", ["~/.claude/plans"]).content).toBe("hi");
        // The home dir itself is never an acceptable root.
        fs.writeFileSync(path.join(home, "secret"), "s");
        expect(codeOf(() => readExternalFile("~/secret", ["~"]))).toBe("not_allowlisted");
      } finally {
        if (prev === undefined) delete process.env.HOME;
        else process.env.HOME = prev;
        fs.rmSync(home, { recursive: true, force: true });
      }
    });

    it("rejects paths outside every root, relative paths, traversal and escaping symlinks", () => {
      const plans = path.join(outside, "plans");
      fs.mkdirSync(plans);
      fs.writeFileSync(path.join(outside, "secret"), "x");
      fs.symlinkSync(path.join(outside, "secret"), path.join(plans, "link"));
      fs.symlinkSync(outside, path.join(plans, "dirlink"));
      expect(codeOf(() => readExternalFile(path.join(outside, "secret"), [plans]))).toBe(
        "not_allowlisted",
      );
      expect(codeOf(() => readExternalFile(path.join(plans, "..", "secret"), [plans]))).toBe(
        "not_allowlisted",
      );
      expect(codeOf(() => readExternalFile("plans/p.md", [plans]))).toBe("invalid");
      expect(codeOf(() => readExternalFile(path.join(plans, "link"), [plans]))).toBe("escape");
      expect(codeOf(() => readExternalFile(path.join(plans, "dirlink", "secret"), [plans]))).toBe(
        "escape",
      );
      expect(codeOf(() => readExternalFile(path.join(plans, "p.md"), []))).toBe("not_allowlisted");
      expect(codeOf(() => readExternalFile(path.join(plans, "p.md"), ["/"]))).toBe(
        "not_allowlisted",
      );
    });
  });
});

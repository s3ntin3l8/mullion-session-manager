import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  symlinkSync,
  utimesSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  MAX_PROJECTS_ROOTS,
  readProjectsRootsOverride,
  resolveAgentProjectsRootsPath,
  resolveEffectiveProjectsRoots,
  validateProjectsRoots,
  writeProjectsRootsOverride,
} from "../../src/services/agent-projects-roots.js";

// Issue #1951 follow-up — an agent's editable project roots. The state file and
// the home-directory guard both resolve against os.homedir(), so HOME is
// pointed at a throwaway directory (same hazard and same remedy as
// agent-bundle-state.test.ts): nothing here may touch the real ~/.mullion.

const originalHome = process.env.HOME;
let sandbox: string;
let home: string;

const app = (env: string, locked = false) =>
  ({
    config: { PROJECTS_ROOTS: env, PROJECTS_ROOTS_LOCKED: locked },
  }) as unknown as FastifyInstance;

const mkdir = (...parts: string[]) => {
  const dir = path.join(sandbox, ...parts);
  mkdirSync(dir, { recursive: true });
  return dir;
};

beforeEach(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), "agent-roots-"));
  home = mkdir("home", "me");
  process.env.HOME = home;
  // A write to a fresh path must not be served from a previous test's cache.
  writeProjectsRootsOverride(null);
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(sandbox, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("validateProjectsRoots", () => {
  it("accepts existing directories and returns them resolved", () => {
    const a = mkdir("work", "a");
    const b = mkdir("work", "b");
    expect(validateProjectsRoots([a, `${b}/`])).toEqual({ ok: true, roots: [a, b] });
  });

  it("expands ~ against this host's home", () => {
    const code = mkdir("home", "me", "code");
    expect(validateProjectsRoots(["~/code"])).toEqual({ ok: true, roots: [code] });
  });

  it("drops duplicates, including the same directory spelled through a symlink", () => {
    const real = mkdir("work", "real");
    const link = path.join(sandbox, "work", "link");
    symlinkSync(real, link);
    expect(validateProjectsRoots([real, link, real])).toEqual({ ok: true, roots: [real] });
  });

  it.each([
    ["not a list", "/x"],
    ["an empty list", []],
    [
      `more than ${MAX_PROJECTS_ROOTS} entries`,
      Array.from({ length: MAX_PROJECTS_ROOTS + 1 }, () => "/x"),
    ],
  ])("refuses %s", (_name, value) => {
    expect(validateProjectsRoots(value)).toMatchObject({ ok: false });
  });

  it("refuses a non-string or blank entry", () => {
    expect(validateProjectsRoots([42])).toMatchObject({ ok: false });
    expect(validateProjectsRoots(["   "])).toMatchObject({ ok: false });
  });

  it("refuses a comma (the env separator) and a relative path", () => {
    expect(validateProjectsRoots(["/a,/b"])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/comma/),
    });
    expect(validateProjectsRoots(["work/code"])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/absolute/),
    });
  });

  it("refuses a '..' segment even when it would resolve somewhere valid", () => {
    const a = mkdir("work", "a");
    expect(validateProjectsRoots([`${a}/../a`])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/\.\./),
    });
  });

  it("refuses a directory that does not exist, and a file", () => {
    expect(validateProjectsRoots([path.join(sandbox, "nope")])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/does not exist/),
    });
    const file = path.join(sandbox, "work-file");
    writeFileSync(file, "x");
    expect(validateProjectsRoots([file])).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a directory/),
    });
  });

  it("refuses the filesystem root, the home directory, and a directory that contains it", () => {
    for (const broad of [
      path.parse(sandbox).root,
      home,
      path.dirname(home),
      path.dirname(path.dirname(home)),
    ]) {
      expect(validateProjectsRoots([broad])).toMatchObject({
        ok: false,
        error: expect.stringMatching(/too broad/),
      });
    }
  });

  it("refuses a credentials directory under home, and anything inside one", () => {
    const ssh = mkdir("home", "me", ".ssh");
    const inner = mkdir("home", "me", ".ssh", "keys");
    for (const dir of [ssh, inner]) {
      expect(validateProjectsRoots([dir])).toMatchObject({
        ok: false,
        error: expect.stringMatching(/credentials/),
      });
    }
  });

  it("refuses a root that is, contains or sits inside one of Mullion's own directories", () => {
    const install = mkdir("home", "me", "opt", "mullion");
    const inside = mkdir("home", "me", "opt", "mullion", "data");
    const parent = path.dirname(install);
    for (const dir of [install, inside, parent]) {
      expect(validateProjectsRoots([dir], { protectedDirs: [install] })).toMatchObject({
        ok: false,
        error: expect.stringMatching(/Mullion's own/),
      });
    }
    // An unrelated sibling is fine.
    const sibling = mkdir("home", "me", "opt", "other");
    expect(validateProjectsRoots([sibling], { protectedDirs: [install] })).toEqual({
      ok: true,
      roots: [sibling],
    });
  });

  it("allows an ordinary directory inside home", () => {
    const code = mkdir("home", "me", "code");
    expect(validateProjectsRoots([code])).toEqual({ ok: true, roots: [code] });
  });
});

describe("the saved override", () => {
  it("is absent until saved, then round-trips, then can be removed", () => {
    expect(readProjectsRootsOverride()).toBeNull();
    const a = mkdir("work", "a");
    writeProjectsRootsOverride([a]);
    expect(existsSync(resolveAgentProjectsRootsPath())).toBe(true);
    expect(readProjectsRootsOverride()).toEqual([a]);
    writeProjectsRootsOverride(null);
    expect(readProjectsRootsOverride()).toBeNull();
    expect(existsSync(resolveAgentProjectsRootsPath())).toBe(false);
  });

  it("removing an override that was never saved is not an error", () => {
    expect(() => writeProjectsRootsOverride(null)).not.toThrow();
  });

  it("treats a corrupt or wrongly-shaped file as no override, never as an empty list", () => {
    mkdirSync(path.dirname(resolveAgentProjectsRootsPath()), { recursive: true });
    for (const body of [
      "{not json",
      '{"version":2,"roots":["/x"]}',
      '{"version":1,"roots":[]}',
      '{"version":1,"roots":[1]}',
      "null",
    ]) {
      writeFileSync(resolveAgentProjectsRootsPath(), body);
      // Bump the mtime so the cache cannot mask the new content.
      const future = new Date(Date.now() + 1000 * Math.random() + 5000);
      utimesSync(resolveAgentProjectsRootsPath(), future, future);
      expect(readProjectsRootsOverride()).toBeNull();
    }
  });

  it("re-validates what it reads: a hand-edited file naming something unsafe is no override", () => {
    const install = mkdir("home", "me", "opt", "mullion");
    mkdirSync(path.dirname(resolveAgentProjectsRootsPath()), { recursive: true });
    for (const roots of [
      [path.parse(sandbox).root],
      [home],
      [install],
      [path.join(sandbox, "gone")],
    ]) {
      writeFileSync(resolveAgentProjectsRootsPath(), JSON.stringify({ version: 1, roots }));
      const future = new Date(Date.now() + 10_000 + Math.random() * 1000);
      utimesSync(resolveAgentProjectsRootsPath(), future, future);
      expect(readProjectsRootsOverride([install])).toBeNull();
    }
  });

  it("does not cache a refusal: a root that is briefly unavailable applies again once it is back", () => {
    // An unmounted share / a permission blip makes validation refuse, and the
    // file's mtime never moves to trigger a re-check - so the verdict must not
    // be remembered.
    const a = mkdir("work", "a");
    writeProjectsRootsOverride([a]);
    expect(readProjectsRootsOverride()).toEqual([a]);
    // Same file content and mtime, but the directory is gone ...
    const file = resolveAgentProjectsRootsPath();
    const stamp = new Date(Date.now() + 20_000);
    utimesSync(file, stamp, stamp);
    expect(readProjectsRootsOverride()).toEqual([a]);
    rmSync(a, { recursive: true, force: true });
    utimesSync(file, new Date(Date.now() + 30_000), new Date(Date.now() + 30_000));
    expect(readProjectsRootsOverride()).toBeNull();
    // ... and back again, with the file untouched.
    mkdirSync(a, { recursive: true });
    expect(readProjectsRootsOverride()).toEqual([a]);
  });

  it("serves a repeated read from the mtime cache but notices an edit", () => {
    const a = mkdir("work", "a");
    const b = mkdir("work", "b");
    writeProjectsRootsOverride([a]);
    expect(readProjectsRootsOverride()).toEqual([a]);
    writeProjectsRootsOverride([b]);
    expect(readProjectsRootsOverride()).toEqual([b]);
  });
});

describe("resolveEffectiveProjectsRoots", () => {
  it("uses the env value when there is no override", () => {
    expect(resolveEffectiveProjectsRoots(app("/srv/a, /srv/b"))).toEqual({
      roots: ["/srv/a", "/srv/b"],
      source: "env",
      overrideIgnored: false,
    });
  });

  it("prefers a saved override", () => {
    const a = mkdir("work", "a");
    writeProjectsRootsOverride([a]);
    expect(resolveEffectiveProjectsRoots(app("/srv/a"))).toEqual({
      roots: [a],
      source: "override",
      overrideIgnored: false,
    });
  });

  it("ignores a saved override when the host's operator pinned the roots, and says so", () => {
    const a = mkdir("work", "a");
    writeProjectsRootsOverride([a]);
    expect(resolveEffectiveProjectsRoots(app("/srv/a", true))).toEqual({
      roots: ["/srv/a"],
      source: "env",
      overrideIgnored: true,
    });
  });

  it("does not report an ignored override when there is none", () => {
    expect(resolveEffectiveProjectsRoots(app("/srv/a", true)).overrideIgnored).toBe(false);
  });
});

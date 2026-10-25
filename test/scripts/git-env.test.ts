import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  GIT_CONFIG_COUNT_KEY,
  GIT_ENV_KEYS_TO_STRIP,
  GIT_NO_AUTO_GC,
} from "../../src/services/git-env.js";
// The plain-JS script module — typed by inference (the test tsconfig's
// allowJs), so no declaration file is needed for it any more.
import * as scriptEnv from "../../scripts/git-env.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import {
  assertConfigUnchanged,
  assertIndexIntact,
  diffConfigSnapshot,
  resolveConfigPath,
  snapshotConfig,
  snapshotIndex,
} from "../helpers/checkout-config.js";

describe("scripts/git-env.mjs", () => {
  it("strips exactly the keys src/services/git-env.ts does", () => {
    expect([...scriptEnv.GIT_ENV_KEYS_TO_STRIP].sort()).toEqual([...GIT_ENV_KEYS_TO_STRIP].sort());
  });

  // Issue #1851 — the gc.auto override and the config-carrier key are part of
  // the same contract, so the twin has to carry them too.
  it("carries the same gc.auto override and config-carrier key", () => {
    expect(scriptEnv.GIT_NO_AUTO_GC).toEqual([...GIT_NO_AUTO_GC]);
    expect(scriptEnv.GIT_CONFIG_COUNT_KEY).toBe(GIT_CONFIG_COUNT_KEY);
  });

  it("removes the config-carrier key from the ambient env", () => {
    const saved = process.env[GIT_CONFIG_COUNT_KEY];
    process.env[GIT_CONFIG_COUNT_KEY] = "3";
    try {
      expect(scriptEnv.gitEnv()[GIT_CONFIG_COUNT_KEY]).toBeUndefined();
      expect(gitEnv()[GIT_CONFIG_COUNT_KEY]).toBeUndefined();
    } finally {
      if (saved === undefined) delete process.env[GIT_CONFIG_COUNT_KEY];
      else process.env[GIT_CONFIG_COUNT_KEY] = saved;
    }
  });

  it("removes every key from the ambient env and pins LC_ALL=C", () => {
    const saved = Object.fromEntries(GIT_ENV_KEYS_TO_STRIP.map((key) => [key, process.env[key]]));
    for (const key of GIT_ENV_KEYS_TO_STRIP) process.env[key] = "/leaked";
    try {
      const env = scriptEnv.gitEnv();
      for (const key of GIT_ENV_KEYS_TO_STRIP) expect(env[key]).toBeUndefined();
      expect(env.LC_ALL).toBe("C");
    } finally {
      for (const key of GIT_ENV_KEYS_TO_STRIP) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
});

describe("checkout-config tripwire (test/global-setup.ts)", () => {
  it("returns null when nothing changed", () => {
    expect(diffConfigSnapshot("core.bare false\n", "core.bare false\n")).toBeNull();
  });

  it("reports added and removed keys", () => {
    const diff = diffConfigSnapshot("core.bare false\n", "core.bare true\nuser.name Test\n");
    expect(diff).toBe("- core.bare false\n+ core.bare true\n+ user.name Test");
  });

  describe("against a real temp repo", () => {
    let dir: string;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { env: gitEnv(), stdio: "pipe" });

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-config-"));
      git("init", "-q", "-b", "main");
    });
    afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

    it("resolves the config path, and null outside a git checkout", () => {
      expect(resolveConfigPath(dir)).toBe(path.join(fs.realpathSync(dir), ".git", "config"));
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
      try {
        expect(resolveConfigPath(bare)).toBeNull();
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("passes when unchanged and throws with the diff when core.* is written", () => {
      const file = resolveConfigPath(dir)!;
      const before = snapshotConfig(file);
      expect(() => assertConfigUnchanged(file, before)).not.toThrow();
      git("config", "--local", "core.ignorecase", "true");
      expect(() => assertConfigUnchanged(file, before)).toThrow(/\+ core\.ignorecase true/);
    });

    it("throws only when over half of the index entries disappear", () => {
      for (const name of ["a", "b", "c", "d"]) fs.writeFileSync(path.join(dir, name), name);
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      const before = snapshotIndex(dir);
      expect(before).toEqual({ head: "refs/heads/main", entries: 4 });
      git("rm", "-q", "--cached", "a");
      expect(() => assertIndexIntact(dir, before)).not.toThrow(); // a developer's edit
      git("rm", "-q", "--cached", "b", "c");
      expect(() => assertIndexIntact(dir, before)).toThrow(/index emptied: 4 -> 1 entries/);
    });

    it("throws when HEAD moves to another branch, not when it gains a commit", () => {
      fs.writeFileSync(path.join(dir, "a"), "a");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      const before = snapshotIndex(dir);
      git("commit", "-q", "--allow-empty", "-m", "mid-run commit");
      expect(() => assertIndexIntact(dir, before)).not.toThrow();
      git("checkout", "-q", "-b", "feat");
      expect(() => assertIndexIntact(dir, before)).toThrow(
        /HEAD moved: refs\/heads\/main -> refs\/heads\/feat/,
      );
    });

    it("snapshots a detached HEAD by its commit", () => {
      fs.writeFileSync(path.join(dir, "a"), "a");
      git("add", "-A");
      git("commit", "-q", "-m", "init");
      git("checkout", "-q", "--detach");
      expect(snapshotIndex(dir)?.head).toMatch(/^detached at [0-9a-f]{40}$/);
    });

    it("skips the check outside a git checkout, and an empty index never trips it", () => {
      const bare = fs.mkdtempSync(path.join(os.tmpdir(), "no-git-"));
      try {
        expect(snapshotIndex(bare)).toBeNull();
        expect(() => assertIndexIntact(bare, null)).not.toThrow();
        const unborn = snapshotIndex(dir);
        expect(unborn).toEqual({ head: "refs/heads/main", entries: 0 });
        expect(() => assertIndexIntact(dir, unborn)).not.toThrow();
      } finally {
        fs.rmSync(bare, { recursive: true, force: true });
      }
    });

    it("treats a config with no watched keys as an empty snapshot", () => {
      const file = path.join(dir, "empty-config");
      fs.writeFileSync(file, '[remote "origin"]\n\turl = x\n');
      expect(snapshotConfig(file)).toBe("");
    });
  });
});

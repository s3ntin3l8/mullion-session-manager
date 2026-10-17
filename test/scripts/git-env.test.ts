import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GIT_ENV_KEYS_TO_STRIP } from "../../src/services/git-env.js";
// @ts-expect-error -- plain-JS script module, no type declarations
import * as scriptEnv from "../../scripts/git-env.mjs";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitEnv } from "../../src/services/git-env.js";
import {
  assertConfigUnchanged,
  diffConfigSnapshot,
  resolveConfigPath,
  snapshotConfig,
} from "../helpers/checkout-config.js";

describe("scripts/git-env.mjs", () => {
  it("strips exactly the keys src/services/git-env.ts does", () => {
    expect([...scriptEnv.GIT_ENV_KEYS_TO_STRIP].sort()).toEqual([...GIT_ENV_KEYS_TO_STRIP].sort());
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
      git("init", "-q");
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

    it("treats a config with no watched keys as an empty snapshot", () => {
      const file = path.join(dir, "empty-config");
      fs.writeFileSync(file, '[remote "origin"]\n\turl = x\n');
      expect(snapshotConfig(file)).toBe("");
    });
  });
});

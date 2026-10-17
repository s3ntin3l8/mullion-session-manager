import { describe, it, expect } from "vitest";
import { GIT_ENV_KEYS_TO_STRIP } from "../../src/services/git-env.js";
// @ts-expect-error -- plain-JS script module, no type declarations
import * as scriptEnv from "../../scripts/git-env.mjs";
import { diffConfigSnapshot } from "../global-setup.js";

describe("scripts/git-env.mjs", () => {
  it("strips exactly the keys src/services/git-env.ts does", () => {
    expect([...scriptEnv.GIT_ENV_KEYS_TO_STRIP].sort()).toEqual([...GIT_ENV_KEYS_TO_STRIP].sort());
  });

  it("removes every key from the ambient env and pins LC_ALL=C", () => {
    for (const key of GIT_ENV_KEYS_TO_STRIP) process.env[key] = "/leaked";
    try {
      const env = scriptEnv.gitEnv();
      for (const key of GIT_ENV_KEYS_TO_STRIP) expect(env[key]).toBeUndefined();
      expect(env.LC_ALL).toBe("C");
    } finally {
      for (const key of GIT_ENV_KEYS_TO_STRIP) delete process.env[key];
    }
  });
});

describe("diffConfigSnapshot (test/global-setup.ts tripwire)", () => {
  it("returns null when nothing changed", () => {
    expect(diffConfigSnapshot("core.bare false\n", "core.bare false\n")).toBeNull();
  });

  it("reports added and removed keys", () => {
    const diff = diffConfigSnapshot("core.bare false\n", "core.bare true\nuser.name Test\n");
    expect(diff).toBe("- core.bare false\n+ core.bare true\n+ user.name Test");
  });
});

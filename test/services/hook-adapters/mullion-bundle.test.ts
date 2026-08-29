import { describe, it, expect, afterEach, beforeEach } from "vitest";
import path from "node:path";
import { resolveMullionBundleDir } from "../../../src/services/hook-adapters/mullion-bundle.js";

// Same resolution shape as shared.test.ts's resolveForwarderPath coverage —
// import.meta.url-relative in a dev checkout, MULLION_HOME's stable
// `current/dist` symlink on a versioned-release install — plus the
// existence check neither of those functions has: resolveMullionBundleDir
// must return null (never a dangling path) whenever the bundle isn't
// actually there, since claude-code.ts's commandTransform decides whether
// to emit `--plugin-dir` based on this return value alone.
describe("resolveMullionBundleDir", () => {
  const originalMullionHome = process.env.MULLION_HOME;

  beforeEach(() => {
    delete process.env.MULLION_HOME;
  });

  afterEach(() => {
    if (originalMullionHome === undefined) delete process.env.MULLION_HOME;
    else process.env.MULLION_HOME = originalMullionHome;
  });

  it("resolves the checked-in src/bundle dir when MULLION_HOME is unset (dev checkout)", () => {
    const dir = resolveMullionBundleDir();
    expect(dir).not.toBeNull();
    expect(dir).not.toContain("current");
    expect(dir?.endsWith(path.join("src", "bundle"))).toBe(true);
  });

  it("returns null when MULLION_HOME points at a location with no bundle", () => {
    process.env.MULLION_HOME = "/nonexistent/mullion/home";
    expect(resolveMullionBundleDir()).toBeNull();
  });

  it("treats a blank MULLION_HOME the same as unset", () => {
    process.env.MULLION_HOME = "   ";
    expect(resolveMullionBundleDir()).not.toBeNull();
  });
});

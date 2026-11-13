import { describe, it, expect } from "vitest";
import {
  withWindowsHide,
  installWindowsHideDefault,
} from "../../src/services/windows-hide-children.js";

describe("withWindowsHide", () => {
  it("adds options after the args array", () => {
    expect(withWindowsHide(["git", ["status"]])).toEqual([
      "git",
      ["status"],
      { windowsHide: true },
    ]);
  });

  it("inserts options before a trailing callback", () => {
    const cb = () => {};
    expect(withWindowsHide(["git", ["status"], cb])).toEqual([
      "git",
      ["status"],
      { windowsHide: true },
      cb,
    ]);
    expect(withWindowsHide(["dir", cb])).toEqual(["dir", { windowsHide: true }, cb]);
  });

  it("defaults windowsHide into an existing options object without mutating it", () => {
    const opts = { cwd: "x" };
    const out = withWindowsHide(["git", [], opts]);
    expect(out[2]).toEqual({ cwd: "x", windowsHide: true });
    expect(opts).toEqual({ cwd: "x" });
  });

  it("respects a caller's explicit windowsHide", () => {
    expect(withWindowsHide(["git", [], { windowsHide: false }])[2]).toEqual({ windowsHide: false });
  });

  it("handles a bare command", () => {
    expect(withWindowsHide(["whoami"])).toEqual(["whoami", { windowsHide: true }]);
  });
});

describe("installWindowsHideDefault", () => {
  it("is a no-op off Windows", () => {
    expect(installWindowsHideDefault("linux")).toBe(false);
  });

  it("patches child_process once on win32, keeping promisify and the callback forms working", async () => {
    // Patches this worker's child_process for the rest of the file; harmless
    // (windowsHide only affects Windows console creation).
    expect(installWindowsHideDefault("win32")).toBe(true);
    expect(installWindowsHideDefault("win32")).toBe(false);
    const cp = await import("node:child_process");
    const { promisify } = await import("node:util");
    const { stdout } = await promisify(cp.execFile)(process.execPath, ["-p", "1+1"]);
    expect(stdout.trim()).toBe("2");
    expect(cp.execFileSync(process.execPath, ["-p", "2+2"]).toString().trim()).toBe("4");
    const r = cp.spawnSync(process.execPath, ["-p", "3+3"], { encoding: "utf8" });
    expect(r.stdout.trim()).toBe("6");
  });
});

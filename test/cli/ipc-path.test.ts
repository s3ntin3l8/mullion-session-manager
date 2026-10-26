import { describe, it, expect } from "vitest";
import { ipcPath, isPipePath, PIPE_PREFIX } from "../../src/cli/ipc-path.mjs";
import { fitsSunPath } from "../../src/cli/sun-path.mjs";

describe("isPipePath", () => {
  it.each([
    "\\\\.\\pipe\\mullion-abc-hooks",
    "\\\\?\\pipe\\mullion-abc-hooks",
    "//./pipe/mullion-abc-hooks",
    "\\\\.\\PIPE\\x",
  ])("recognises %s as a named pipe", (p) => {
    expect(isPipePath(p)).toBe(true);
  });

  it.each([
    "/data/sessions/hooks.sock",
    "C:\\data\\sessions\\hooks.sock",
    "\\\\server\\share\\hooks.sock",
    "relative/pipe/hooks.sock",
  ])("does not treat %s as a named pipe", (p) => {
    expect(isPipePath(p)).toBe(false);
  });
});

describe("ipcPath", () => {
  it.each(["linux", "darwin"] as const)("returns the path unchanged on %s", (platform) => {
    expect(ipcPath("/data/sessions/hooks.sock", platform)).toBe("/data/sessions/hooks.sock");
  });

  it("maps a socket path to a named pipe on win32, keeping the socket's own name", () => {
    const pipe = ipcPath("C:\\data\\sessions\\hooks.sock", "win32");
    expect(pipe.startsWith(PIPE_PREFIX)).toBe(true);
    expect(pipe).toMatch(/^\\\\\.\\pipe\\mullion-[0-9a-f]{16}-hooks$/);
    expect(isPipePath(pipe)).toBe(true);
  });

  it("is deterministic, and case-insensitive like the Windows paths it maps", () => {
    expect(ipcPath("C:\\Data\\Sessions\\hooks.sock", "win32")).toBe(
      ipcPath("c:\\data\\sessions\\hooks.sock", "win32"),
    );
  });

  it("names the same pipe for either slash direction", () => {
    expect(ipcPath("C:/data/sessions/42.sock", "win32")).toBe(
      ipcPath("C:\\data\\sessions\\42.sock", "win32"),
    );
  });

  it("keeps two instances' endpoints apart — the same socket name in different dirs", () => {
    expect(ipcPath("C:\\agent\\sessions\\hooks.sock", "win32")).not.toBe(
      ipcPath("C:\\primary\\sessions\\hooks.sock", "win32"),
    );
  });

  it("keeps two endpoints in one dir apart", () => {
    expect(ipcPath("C:\\s\\1.sock", "win32")).not.toBe(ipcPath("C:\\s\\11.sock", "win32"));
  });

  it("takes a path that already names a pipe as given, so the mapping is idempotent", () => {
    const pipe = ipcPath("C:\\data\\sessions\\mullion.sock", "win32");
    expect(ipcPath(pipe, "win32")).toBe(pipe);
    expect(ipcPath("\\\\.\\pipe\\operator-chosen", "win32")).toBe("\\\\.\\pipe\\operator-chosen");
  });

  it("normalises a forward-slash pipe spelling to the backslash form the namespace accepts", () => {
    expect(ipcPath("//./pipe/operator-chosen", "win32")).toBe("\\\\.\\pipe\\operator-chosen");
  });
});

describe("fitsSunPath on win32", () => {
  it("accepts any directory — named pipes have no sun_path limit", () => {
    const deep = `C:\\${"very-long-directory-name\\".repeat(20)}sessions`;
    expect(fitsSunPath(deep, "win32")).toBe(true);
    // ...while the same length still does not fit on Linux.
    expect(fitsSunPath(`/${"very-long-directory-name/".repeat(20)}sessions`, "linux")).toBe(false);
  });
});

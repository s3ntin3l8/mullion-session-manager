import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";

// Issue #1728 — a host with no session shell (Windows without Git Bash)
// cannot run a session, so a login-shell probe finds nothing: it resolves
// null without spawning anything, instead of failing. An unexpected error
// resolving the shell is logged but still resolves null — runLoginShell
// never rejects (agent-detect.ts awaits every probe in one Promise.all).

const spawnMock = vi.fn();
let shellResult: () => string | null = () => null;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock("../../src/services/session-shell.js", () => ({
  sessionShellOrNull: () => shellResult(),
}));

import { runLoginShell } from "../../src/services/login-shell.js";

afterEach(() => {
  spawnMock.mockReset();
  shellResult = () => null;
  vi.restoreAllMocks();
});

describe("runLoginShell without a session shell", () => {
  it("resolves null and spawns nothing", async () => {
    await expect(runLoginShell("command -v claude")).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("resolves null — never rejects — when resolving the shell fails unexpectedly, and says so", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    shellResult = () => {
      throw Object.assign(new Error("EACCES"), { code: "EACCES" });
    };
    await expect(runLoginShell("command -v claude")).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("could not resolve the session shell"),
      expect.objectContaining({ message: "EACCES" }),
    );
  });
});

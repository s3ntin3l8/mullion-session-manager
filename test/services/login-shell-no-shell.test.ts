import { describe, it, expect, vi } from "vitest";
import type * as ChildProcess from "node:child_process";

// Issue #1728 — a host with no session shell (Windows without Git Bash)
// cannot run a session, so a login-shell probe finds nothing: it resolves
// null without spawning anything, instead of failing.

const spawnMock = vi.fn();

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return { ...actual, spawn: (...args: unknown[]) => spawnMock(...args) };
});

vi.mock("../../src/services/session-shell.js", () => ({
  sessionShellOrNull: () => null,
}));

import { runLoginShell } from "../../src/services/login-shell.js";

describe("runLoginShell without a session shell", () => {
  it("resolves null and spawns nothing", async () => {
    await expect(runLoginShell("command -v claude")).resolves.toBeNull();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

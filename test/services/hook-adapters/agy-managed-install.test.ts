import { describe, it, expect, vi, beforeEach } from "vitest";
import os from "node:os";

// A separate file from agy.test.ts specifically so node:fs can be mocked
// module-wide here — agy.test.ts's other 24 tests rely on the REAL fs for
// scratch-dir I/O, which a file-level vi.mock("node:fs") would break.
//
// Locks in the actual PRODUCTION gate (prepareLaunch's managedInstall
// deciding whether to call mergeAgyTrustedWorkspace at all), not just the
// merge function's own logic once called — agy.test.ts's existing tests
// only exercise mergeAgyTrustedWorkspace directly via __testing with an
// injected path, never prepareLaunch's own skipPermissions/cwd gate.
//
// Verified empirically before writing this: vi.spyOn on the __testing
// export does NOT intercept mergeAgyTrustedWorkspace's internal
// resolveAgyTrustedWorkspacesPath() default-parameter call (same-module
// plain function calls resolve lexically, not through the export object) —
// so os.homedir() is stubbed instead, which the real function calls via a
// genuine property access on every invocation (mergeAgyHooks/
// mergeAgyMcpConfig too, harmlessly, since all fs calls are mocked below).
const mockWriteFileSync = vi.fn();
const mockReadFileSync = vi.fn(() => {
  throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
});
const mockMkdirSync = vi.fn();

vi.mock("node:fs", () => ({
  readFileSync: mockReadFileSync,
  writeFileSync: mockWriteFileSync,
  mkdirSync: mockMkdirSync,
}));

const { agyAdapter } = await import("../../../src/services/hook-adapters/agy.js");

function baseCtx(overrides: Partial<Parameters<typeof agyAdapter.prepareLaunch>[0]> = {}) {
  return {
    sessionId: "1",
    sessionsDir: "/tmp/mullion-sessions",
    hookSocketPath: "/tmp/mullion-sessions/hooks.sock",
    hookToken: "tok",
    controlSocketPath: "/tmp/mullion-sessions/mullion.sock",
    forwarderPath: "/abs/install/hooks/forwarder.mjs",
    reviewGateEnabled: false,
    injectAgentGuide: false,
    ...overrides,
  };
}

function trustedWorkspacesWriteCalls() {
  return mockWriteFileSync.mock.calls.filter(([path]) =>
    String(path).includes("antigravity-cli/settings.json"),
  );
}

describe("agyAdapter.prepareLaunch managedInstall gating (Hermes review, PR #573)", () => {
  beforeEach(() => {
    mockWriteFileSync.mockClear();
    mockReadFileSync.mockClear();
    mockMkdirSync.mockClear();
    vi.spyOn(os, "homedir").mockReturnValue("/tmp/PROBE_HOME");
  });

  it("pre-trusts the cwd when skipPermissions is true and cwd is set", async () => {
    const ctx = baseCtx({
      skipPermissions: true,
      cwd: "/srv/repo/.mullion-worktrees/mullion-task-1",
    });
    await agyAdapter.prepareLaunch(ctx).managedInstall?.();

    const calls = trustedWorkspacesWriteCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toContain("/tmp/PROBE_HOME");
    expect(String(calls[0][1])).toContain("/srv/repo/.mullion-worktrees/mullion-task-1");
  });

  it("does NOT pre-trust anything when skipPermissions is false (the default)", async () => {
    const ctx = baseCtx({
      skipPermissions: false,
      cwd: "/srv/repo/.mullion-worktrees/mullion-task-1",
    });
    await agyAdapter.prepareLaunch(ctx).managedInstall?.();

    expect(trustedWorkspacesWriteCalls()).toHaveLength(0);
  });

  it("does NOT pre-trust anything when skipPermissions is true but cwd is absent", async () => {
    const ctx = baseCtx({ skipPermissions: true });
    await agyAdapter.prepareLaunch(ctx).managedInstall?.();

    expect(trustedWorkspacesWriteCalls()).toHaveLength(0);
  });

  it("does NOT pre-trust anything when skipPermissions/cwd are both simply absent (manual launch)", async () => {
    const ctx = baseCtx();
    await agyAdapter.prepareLaunch(ctx).managedInstall?.();

    expect(trustedWorkspacesWriteCalls()).toHaveLength(0);
  });
});

function hooksWriteCalls() {
  return mockWriteFileSync.mock.calls.filter(([path]) => String(path).includes("hooks.json"));
}

function mcpConfigWriteCalls() {
  return mockWriteFileSync.mock.calls.filter(([path]) => String(path).includes("mcp_config.json"));
}

// Task Master trial 220921 / PR #743's actual incident: a real host's
// ~/.gemini/config/mcp_config.json was unreadable in a way that threw
// (empty-file tolerance is covered separately in agy.test.ts — this suite
// only cares about managedInstall's OWN behavior once one step throws for
// any reason at all), which used to abort every later step in the same
// `managedInstall` call — most importantly mergeAgyTrustedWorkspace,
// leaving an unattended review agent blocked on agy's own interactive
// folder-trust prompt for its whole lifetime. These tests lock in that each
// step is now independently guarded, run in trust-first order, and that a
// failure is still surfaced (not swallowed silently down to zero signal).
describe("agyAdapter.prepareLaunch managedInstall independent step guarding (trial 220921 / PR #743)", () => {
  beforeEach(() => {
    mockWriteFileSync.mockClear();
    mockReadFileSync.mockClear();
    mockMkdirSync.mockClear();
    vi.spyOn(os, "homedir").mockReturnValue("/tmp/PROBE_HOME");
  });

  it("still pre-trusts the cwd and writes hooks.json when mcp_config.json is unreadable", async () => {
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes("mcp_config.json")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const ctx = baseCtx({
      skipPermissions: true,
      cwd: "/srv/repo/.mullion-worktrees/mullion-task-220921",
    });

    await expect(agyAdapter.prepareLaunch(ctx).managedInstall?.()).rejects.toThrow();

    // The whole point of the fix: the trust write and the hooks write both
    // still happened, even though mcp_config.json's step threw.
    expect(trustedWorkspacesWriteCalls()).toHaveLength(1);
    expect(hooksWriteCalls()).toHaveLength(1);
    expect(mcpConfigWriteCalls()).toHaveLength(0);
  });

  it("still writes hooks.json and mcp_config.json when the trust write itself throws", async () => {
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes("antigravity-cli/settings.json")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const ctx = baseCtx({
      skipPermissions: true,
      cwd: "/srv/repo/.mullion-worktrees/mullion-task-220921",
    });

    await expect(agyAdapter.prepareLaunch(ctx).managedInstall?.()).rejects.toThrow();

    expect(trustedWorkspacesWriteCalls()).toHaveLength(0);
    expect(hooksWriteCalls()).toHaveLength(1);
    expect(mcpConfigWriteCalls()).toHaveLength(1);
  });

  it("still rejects (so applyHookAdapters' own failure log still fires) when only one step fails", async () => {
    mockReadFileSync.mockImplementation((filePath: unknown) => {
      if (String(filePath).includes("mcp_config.json")) {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const ctx = baseCtx({ skipPermissions: true, cwd: "/srv/repo/x" });

    await expect(agyAdapter.prepareLaunch(ctx).managedInstall?.()).rejects.toThrow(
      /EACCES|permission denied/,
    );
  });

  it("runs the trust write BEFORE hooks/MCP wiring (order, not just independence)", async () => {
    // Explicit reset — mockClear() (in beforeEach) does not remove a prior
    // test's mockImplementation override, and this test needs every read to
    // resolve to "missing" (the ordinary case) rather than inherit an
    // earlier test's EACCES-on-one-path behavior.
    mockReadFileSync.mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    const order: string[] = [];
    mockWriteFileSync.mockImplementation((filePath: unknown) => {
      const p = String(filePath);
      if (p.includes("antigravity-cli/settings.json")) order.push("trust");
      else if (p.includes("mcp_config.json")) order.push("mcp");
      else if (p.includes("hooks.json")) order.push("hooks");
    });
    const ctx = baseCtx({ skipPermissions: true, cwd: "/srv/repo/x" });

    await agyAdapter.prepareLaunch(ctx).managedInstall?.();

    expect(order[0]).toBe("trust");
  });
});

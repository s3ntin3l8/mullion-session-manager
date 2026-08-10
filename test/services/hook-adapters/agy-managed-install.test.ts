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

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Issue #1089 — agent-bundle-state.ts's plain read/write functions do real
// os.homedir()-based filesystem I/O (same hazard bundle-sync.ts's own
// resolveBundleSyncManifestPath has — see test/services/bundle-sync.test.ts's
// own header comment for why HOME is overridden rather than the real thing
// touched). getHostBundleDisabled/removeHostBundle's dispatch half mirrors
// test/services/host-files.test.ts exactly: mock remote-host-client.js and
// bundle-sync.js (uninstallBundleContent does a real manifest-driven removal
// plus a legacy sweep across ~/.claude/skills etc. — never run it for real
// in a test) at the module boundary, assert dispatch/mapping only.

const originalHome = process.env.HOME;
let homeDir: string;

const mockGetRemoteHostClient = vi.fn();
vi.mock("../../src/services/remote-host-client.js", () => ({
  getRemoteHostClient: mockGetRemoteHostClient,
  HostRequestError: class extends Error {
    statusCode: number;
    constructor(hostId: string, statusCode: number, body: string) {
      super(`Host ${hostId} rejected the request: HTTP ${statusCode}${body ? ` — ${body}` : ""}`);
      this.name = "HostRequestError";
      this.statusCode = statusCode;
    }
  },
  HostUnreachableError: class extends Error {
    constructor(hostId: string, cause: unknown) {
      super(
        `Host ${hostId} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
      this.name = "HostUnreachableError";
    }
  },
}));

const uninstallBundleContentMock = vi.fn(async () => ({ removed: 3, legacySwept: 1 }));
vi.mock("../../src/services/bundle-sync.js", () => ({
  uninstallBundleContent: () => uninstallBundleContentMock(),
}));

const {
  resolveAgentBundleStatePath,
  readAgentBundleDisabled,
  writeAgentBundleDisabled,
  getHostBundleDisabled,
  removeHostBundle,
} = await import("../../src/services/agent-bundle-state.js");
const { HostUnreachableError, HostRequestError } =
  await import("../../src/services/remote-host-client.js");

const fakeApp = { config: {} } as never;

describe("agent-bundle-state.ts", () => {
  beforeEach(() => {
    homeDir = mkdtempSync(path.join(os.tmpdir(), "agent-bundle-state-fakehome-"));
    process.env.HOME = homeDir;
    vi.clearAllMocks();
    uninstallBundleContentMock.mockResolvedValue({ removed: 3, legacySwept: 1 });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(homeDir, { recursive: true, force: true });
  });

  describe("readAgentBundleDisabled / writeAgentBundleDisabled", () => {
    it("defaults to false (enabled) when the state file doesn't exist yet", () => {
      expect(existsSync(resolveAgentBundleStatePath())).toBe(false);
      expect(readAgentBundleDisabled()).toBe(false);
    });

    it("round-trips true", () => {
      writeAgentBundleDisabled(true);
      expect(readAgentBundleDisabled()).toBe(true);
    });

    it("round-trips false after being set true", () => {
      writeAgentBundleDisabled(true);
      writeAgentBundleDisabled(false);
      expect(readAgentBundleDisabled()).toBe(false);
    });

    it("persists as versioned JSON under ~/.mullion/", () => {
      writeAgentBundleDisabled(true);
      const raw = readFileSync(resolveAgentBundleStatePath(), "utf8");
      expect(JSON.parse(raw)).toEqual({ version: 1, disabled: true });
    });

    it("defaults to false for a corrupt/unparseable state file rather than throwing", () => {
      writeAgentBundleDisabled(true);
      const target = resolveAgentBundleStatePath();
      // Overwrite with garbage after a valid write, to prove the read path
      // itself (not just "file never existed") fails safe.
      writeFileSync(target, "not json");
      expect(readAgentBundleDisabled()).toBe(false);
    });
  });

  describe("getHostBundleDisabled", () => {
    it("local: reads the real persisted flag", async () => {
      writeAgentBundleDisabled(true);

      const result = await getHostBundleDisabled(fakeApp, "local");

      expect(result).toEqual({ ok: true, value: true });
    });

    it("remote: proxies to the remote client's getAgentBundleState", async () => {
      const mockGetState = vi.fn().mockResolvedValue({ disabled: true });
      mockGetRemoteHostClient.mockReturnValue({ getAgentBundleState: mockGetState });

      const result = await getHostBundleDisabled(fakeApp, "remote-host-1");

      expect(mockGetState).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: true });
    });

    it("remote: an unreachable host maps to reason 'unreachable'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        getAgentBundleState: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("h1", new Error("timeout"))),
      });

      const result = await getHostBundleDisabled(fakeApp, "remote-host-1");

      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("unreachable");
    });
  });

  describe("removeHostBundle", () => {
    it("local: writes the disabled flag then runs the real removal", async () => {
      const result = await removeHostBundle(fakeApp, "local");

      expect(readAgentBundleDisabled()).toBe(true);
      expect(uninstallBundleContentMock).toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: { removed: 3, legacySwept: 1 } });
    });

    it("local: disabled=false only clears the flag, without running removal", async () => {
      writeAgentBundleDisabled(true);

      const result = await removeHostBundle(fakeApp, "local", false);

      expect(readAgentBundleDisabled()).toBe(false);
      expect(uninstallBundleContentMock).not.toHaveBeenCalled();
      expect(result).toEqual({ ok: true, value: { removed: 0, legacySwept: 0 } });
    });

    it("remote: proxies to the remote client's removeAgentBundle", async () => {
      const mockRemove = vi.fn().mockResolvedValue({ removed: 5, legacySwept: 2 });
      mockGetRemoteHostClient.mockReturnValue({ removeAgentBundle: mockRemove });

      const result = await removeHostBundle(fakeApp, "remote-host-1");

      expect(mockRemove).toHaveBeenCalledWith(true);
      expect(result).toEqual({ ok: true, value: { removed: 5, legacySwept: 2 } });
    });

    it("remote: an old agent build (404) maps to reason 'unsupported'", async () => {
      mockGetRemoteHostClient.mockReturnValue({
        removeAgentBundle: vi.fn().mockRejectedValue(new HostRequestError("h1", 404, "")),
      });

      const result = await removeHostBundle(fakeApp, "remote-host-1");

      expect(result).toEqual({ ok: false, reason: "unsupported" });
    });
  });
});

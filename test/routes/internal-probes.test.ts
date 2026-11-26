import type * as HostCapabilities from "../../src/services/host-capabilities.js";
import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerProbeRoutes } from "../../src/routes/internal-probes.js";
import {
  resetUserShellEnvForTests,
  resolveUserShellEnv,
} from "../../src/services/user-shell-env.js";
import { localProtocolInfo } from "../../src/shared/agent-protocol.js";

vi.mock("../../src/services/host-capabilities.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostCapabilities>()),
  warmCapabilitiesOnReady: vi.fn(),
  getCachedCapabilities: vi.fn().mockResolvedValue(["xcode"]),
}));

// The auth gate is internalRoutes' own onRequest hook (covered by
// internal.test.ts); this pins what the probes answer.
describe("agent probe routes (issues #2306, #2248)", () => {
  it("answers the protocol handshake from the shared registry", async () => {
    const app = Fastify();
    registerProbeRoutes(app, {});
    const res = await app.inject({ method: "GET", url: "/internal/protocol" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(localProtocolInfo());
    const info = res.json() as { protocolVersion: number; operations: string[] };
    expect(typeof info.protocolVersion).toBe("number");
    expect(info.operations.length).toBeGreaterThan(0);
    await app.close();
  });

  it("answers this host's capabilities", async () => {
    const app = Fastify();
    registerProbeRoutes(app, {});
    const res = await app.inject({ method: "GET", url: "/internal/capabilities" });
    expect(res.json()).toEqual({ capabilities: ["xcode"] });
    await app.close();
  });

  it("answers the session env with no variable values, reporting a fallback and why (#3156)", async () => {
    const saved = { ...process.env };
    process.env.MULLION_RESOLVE_INTERACTIVE_ENV = "0";
    process.env.PROBE_CANARY_VAR = "canary-value-123";
    process.env.SHELL = "/bin/zsh";
    resetUserShellEnvForTests();
    try {
      const app = Fastify();
      registerProbeRoutes(app, {});
      const res = await app.inject({ method: "GET", url: "/internal/session-env" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        shell: "/bin/zsh",
        interactiveResolve: "fallback",
        reason: "disabled",
        retryAt: null,
        path: expect.any(Array),
        recoveredKeys: [],
      });
      expect(res.body).not.toContain("canary-value-123");
      await app.close();
    } finally {
      process.env = saved;
      resetUserShellEnvForTests();
    }
  });

  it("reports an unsupported shell as a fallback reason", async () => {
    const saved = { ...process.env };
    delete process.env.MULLION_RESOLVE_INTERACTIVE_ENV;
    process.env.SHELL = "/usr/bin/fish";
    resetUserShellEnvForTests();
    try {
      await resolveUserShellEnv();
      const app = Fastify();
      registerProbeRoutes(app, {});
      const body = (await app.inject({ method: "GET", url: "/internal/session-env" })).json();
      expect(body).toMatchObject({ interactiveResolve: "fallback", reason: "unsupported-shell" });
      await app.close();
    } finally {
      process.env = saved;
      resetUserShellEnvForTests();
    }
  });
});

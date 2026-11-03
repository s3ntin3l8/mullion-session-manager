import { describe, it, expect, vi } from "vitest";
import Fastify from "fastify";
import { registerProbeRoutes } from "../../src/routes/internal-probes.js";
import { localProtocolInfo } from "../../src/shared/agent-protocol.js";

vi.mock("../../src/services/host-capabilities.js", () => ({
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
});

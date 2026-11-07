import { describe, it, expect } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  bindChannelHost,
  hasReachablePath,
  unbindChannelHost,
} from "../../src/services/agent-channel-tunnel.js";

// #2636 — hasReachablePath gates the fan-outs and syncs (events, control relay,
// ssh-agent, bundle sync, project creation): an address, a connected channel,
// or a channel bound from an earlier connection each make a host reachable.
function fakeApp(connected: string[] = []): FastifyInstance {
  return { agentChannels: new Map(connected.map((id) => [id, {}])) } as unknown as FastifyInstance;
}

describe("hasReachablePath", () => {
  it("is true for an addressed host with no channel at all", () => {
    expect(hasReachablePath(fakeApp(), { id: "h1", baseUrl: "http://h1:4000" })).toBe(true);
  });

  it("is false for a host with neither an address nor a channel", () => {
    expect(hasReachablePath(fakeApp(), { id: "h1", baseUrl: null })).toBe(false);
  });

  it("is true for an outbound-only host whose channel is connected right now", () => {
    expect(hasReachablePath(fakeApp(["h1"]), { id: "h1", baseUrl: null })).toBe(true);
  });

  it("is true for a bound but currently disconnected host, until it is unbound", () => {
    const app = fakeApp();
    bindChannelHost(app, "h1");
    expect(hasReachablePath(app, { id: "h1", baseUrl: null })).toBe(true);
    unbindChannelHost(app, "h1");
    expect(hasReachablePath(app, { id: "h1", baseUrl: null })).toBe(false);
  });

  it("does not leak a binding to another host", () => {
    const app = fakeApp();
    bindChannelHost(app, "h1");
    expect(hasReachablePath(app, { id: "h2", baseUrl: null })).toBe(false);
  });
});

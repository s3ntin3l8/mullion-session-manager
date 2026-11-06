import { describe, it, expect } from "vitest";
import { buildApp } from "../../src/app.js";
import { bindChannelHost } from "../../src/services/agent-channel-tunnel.js";

describe("hosts route channel binding (#2622)", () => {
  it("reports a bound host as 'bound to the outbound channel, not connected' and supports unbinding", async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "bound-host", baseUrl: "http://127.0.0.1:2", token: "t" },
    });
    const hostId = created.json().id as string;

    // Initially not bound
    let list = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
    let hostEntry = list.find((h: { id: string }) => h.id === hostId);
    expect(hostEntry.channel).toMatchObject({
      ready: false,
      bound: false,
      status: "not connected",
    });

    // Bind the host
    bindChannelHost(app, hostId);

    list = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
    hostEntry = list.find((h: { id: string }) => h.id === hostId);
    expect(hostEntry.channel).toMatchObject({
      ready: false,
      bound: true,
      status: "bound to the outbound channel, not connected",
    });

    // Unbind
    const unbindRes = await app.inject({
      method: "POST",
      url: `/api/hosts/${hostId}/unbind`,
    });
    expect(unbindRes.statusCode).toBe(200);
    expect(unbindRes.json()).toEqual({ ok: true });

    // After unbinding
    list = (await app.inject({ method: "GET", url: "/api/hosts" })).json();
    hostEntry = list.find((h: { id: string }) => h.id === hostId);
    expect(hostEntry.channel).toMatchObject({
      ready: false,
      bound: false,
      status: "not connected",
    });

    // 404 for local and unknown hosts
    const localUnbind = await app.inject({ method: "POST", url: "/api/hosts/local/unbind" });
    expect(localUnbind.statusCode).toBe(404);
    const unknownUnbind = await app.inject({ method: "POST", url: "/api/hosts/nope/unbind" });
    expect(unknownUnbind.statusCode).toBe(404);

    await app.close();
  });
});

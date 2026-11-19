import net from "node:net";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { listenWithAgentFallback, type ListenTarget } from "../src/listen.js";

const apps: ListenTarget[] = [];
const servers: net.Server[] = [];

function make(host: string, role: string, port = 0) {
  const warnings: string[] = [];
  const app = Fastify({ logger: false });
  const warn = app.log.warn.bind(app.log);
  (app.log as { warn: unknown }).warn = (...a: unknown[]) => {
    warnings.push(String(a[a.length - 1]));
    return warn(...(a as [string]));
  };
  const target = Object.assign(app, {
    config: { HOST: host, PORT: port, MULLION_ROLE: role },
  }) as unknown as ListenTarget;
  apps.push(target);
  return { app: target, warnings };
}

afterEach(async () => {
  for (const a of apps.splice(0)) await (a as unknown as { close(): Promise<void> }).close();
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

describe("listenWithAgentFallback", () => {
  it("agent with an unavailable HOST falls back to loopback and warns", async () => {
    const { app, warnings } = make("192.0.2.1", "agent");
    const address = await listenWithAgentFallback(app);
    expect(address).toContain("127.0.0.1");
    expect(warnings.some((w) => w.includes("192.0.2.1"))).toBe(true);
  });

  it("primary with an unavailable HOST rejects with EADDRNOTAVAIL", async () => {
    const { app } = make("192.0.2.1", "primary");
    await expect(listenWithAgentFallback(app)).rejects.toMatchObject({ code: "EADDRNOTAVAIL" });
  });

  it("loopback HOST is untouched, no warning", async () => {
    const { app, warnings } = make("127.0.0.1", "agent");
    expect(await listenWithAgentFallback(app)).toContain("127.0.0.1");
    expect(warnings).toEqual([]);
  });

  it("EADDRINUSE is not swallowed", async () => {
    const s = net.createServer();
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as net.AddressInfo).port;
    const { app, warnings } = make("127.0.0.1", "agent", port);
    await expect(listenWithAgentFallback(app)).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(warnings).toEqual([]);
  });
});

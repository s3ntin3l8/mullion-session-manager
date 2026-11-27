import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { AGENT_CHANNEL_AUTH_HEADER } from "../../src/services/agent-channel-tunnel.js";

// Issue #2451 — the internal API's auth gate accepts a request replayed from
// the outbound agent channel only with the process-local token, and the token
// alone is enough (no bearer, no signature). Kept in its own file for its
// no-static-token enrolled-agent env setup.

const { buildApp } = await import("../../src/app.js");

describe("internal routes: requests replayed from the outbound channel (#2451)", () => {
  let projectsRoot: string;
  let sessionsDir: string;

  beforeAll(async () => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-channel-auth-"));
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "internal-channel-auth-sessions-"));
    process.env.MULLION_ROLE = "agent";
    process.env.PROJECTS_ROOTS = projectsRoot;
    // No static MULLION_AGENT_TOKEN, as on an enrolled agent. Issue #3577:
    // booting needs a stored identity. Port 1 refuses fast so the enrollment
    // plugin's retry loop does not hang the test.
    const { identityStatePath } = await import("../../src/services/agent-identity.js");
    process.env.SESSIONS_DIR = sessionsDir;
    fs.writeFileSync(
      identityStatePath(sessionsDir),
      JSON.stringify({ hostId: "host-1", machineCredential: "a1".repeat(32) }),
    );
    process.env.MULLION_PRIMARY_URL = "http://127.0.0.1:1";
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.SESSIONS_DIR;
    delete process.env.MULLION_PRIMARY_URL;
  });

  it("accepts the process-local token and nothing else", async () => {
    const app = await buildApp();
    const token = app.agentChannelRequestToken;
    expect(token.length).toBeGreaterThanOrEqual(32);
    const get = (value: string | undefined) =>
      app.inject({
        method: "GET",
        url: "/internal/discover",
        headers: value === undefined ? {} : { [AGENT_CHANNEL_AUTH_HEADER]: value },
      });
    expect((await get(token)).statusCode).toBe(200);
    for (const wrong of [undefined, "", token.slice(1), "x".repeat(token.length)]) {
      expect((await get(wrong)).statusCode).toBe(401);
    }
    await app.close();
  });

  it("does not hand the channel token to a preview's dev server", async () => {
    let seen: http.IncomingHttpHeaders = {};
    const dev = http.createServer((req, res) => {
      seen = req.headers;
      res.end("ok");
    });
    await new Promise<void>((r) => dev.listen(0, "127.0.0.1", r));
    const devPort = (dev.address() as AddressInfo).port;
    const app = await buildApp();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/internal/preview/${devPort}/x`,
        headers: { [AGENT_CHANNEL_AUTH_HEADER]: app.agentChannelRequestToken, cookie: "a=b" },
      });
      expect(res.statusCode).toBe(200);
      // The replay's own credential never reaches project code; the browser's
      // headers do.
      expect(seen[AGENT_CHANNEL_AUTH_HEADER]).toBeUndefined();
      expect(seen.cookie).toBe("a=b");
    } finally {
      await app.close();
      await new Promise<void>((r) => dev.close(() => r()));
    }
  });
});

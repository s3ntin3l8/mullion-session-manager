import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { AGENT_CHANNEL_AUTH_HEADER } from "../../src/services/agent-channel-tunnel.js";

// Issue #2451 — the internal API's auth gate accepts a request replayed from
// the outbound agent channel only with the process-local token, and the token
// alone is enough (no bearer, no signature). Its own file: routes/internal.test.ts
// is over the file-size ratchet.

const { buildApp } = await import("../../src/app.js");

describe("internal routes: requests replayed from the outbound channel (#2451)", () => {
  let projectsRoot: string;

  beforeAll(() => {
    projectsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "internal-channel-auth-"));
    process.env.MULLION_ROLE = "agent";
    process.env.PROJECTS_ROOTS = projectsRoot;
    // No static MULLION_AGENT_TOKEN, as on an enrolled agent. Port 1 refuses
    // fast so the enrollment plugin's retry loop does not hang the test.
    process.env.MULLION_PRIMARY_URL = "http://127.0.0.1:1";
    process.env.MULLION_ENROLLMENT_TOKEN = "unused-in-this-test";
  });

  afterAll(() => {
    fs.rmSync(projectsRoot, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
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
});

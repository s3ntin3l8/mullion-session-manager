import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { HostRequestError, RemoteHostClient } from "../../src/services/remote-host-client.js";
import { taskCiUnfixablePath } from "../../src/services/task-prompt.js";

// The agent's GET /internal/task-ci-unfixable (the proxy target of
// SessionBackend.readTaskCiUnfixable for a remote-hosted worker) and the
// RemoteHostClient method that calls it.
const TOKEN = "ci-unfixable-agent-token";
const headers = { authorization: `Bearer ${TOKEN}` };
const HEAD = "e".repeat(40);

describe("GET /internal/task-ci-unfixable (agent role)", () => {
  beforeAll(() => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
  });

  afterAll(() => {
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    closeDb();
  });

  it("returns { content: null } (200, not 404) for an absent file", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/task-ci-unfixable?taskId=999&headSha=${HEAD}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ content: null });
    await app.close();
  });

  it("returns the worker's reason, a placeholder for an empty file, and keys by head", async () => {
    const app = await buildApp();
    const dir = path.dirname(app.pty.hookSocketPath);
    const withReason = taskCiUnfixablePath(dir, 7, HEAD);
    const empty = taskCiUnfixablePath(dir, 8, HEAD);
    fs.writeFileSync(withReason, "  upstream advisory, no patch \n");
    fs.writeFileSync(empty, "  \n");
    const get = (taskId: number, sha: string) =>
      app.inject({
        method: "GET",
        url: `/internal/task-ci-unfixable?taskId=${taskId}&headSha=${sha}`,
        headers,
      });

    expect((await get(7, HEAD)).json()).toEqual({ content: "upstream advisory, no patch" });
    expect((await get(8, HEAD)).json()).toEqual({ content: "(no reason given)" });
    // A declaration about one head is invisible for another.
    expect((await get(7, "f".repeat(40))).json()).toEqual({ content: null });

    fs.rmSync(withReason, { force: true });
    fs.rmSync(empty, { force: true });
    await app.close();
  });

  it("rejects a bad taskId or headSha with 400 and never accepts a path fragment", async () => {
    const app = await buildApp();
    for (const url of [
      `/internal/task-ci-unfixable?taskId=abc&headSha=${HEAD}`,
      `/internal/task-ci-unfixable?taskId=0&headSha=${HEAD}`,
      `/internal/task-ci-unfixable?taskId=-3&headSha=${HEAD}`,
      "/internal/task-ci-unfixable?taskId=1",
      "/internal/task-ci-unfixable?taskId=1&headSha=abc",
      `/internal/task-ci-unfixable?taskId=1&headSha=${"E".repeat(40)}`,
      `/internal/task-ci-unfixable?taskId=1&headSha=${encodeURIComponent("../../etc/passwd")}`,
      `/internal/task-ci-unfixable?taskId=1&headSha=${HEAD}/../x`,
    ]) {
      const res = await app.inject({ method: "GET", url, headers });
      expect(res.statusCode, url).toBe(400);
    }
    await app.close();
  });

  it("requires the agent token", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/task-ci-unfixable?taskId=1&headSha=${HEAD}`,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("RemoteHostClient.resolveReadTaskCiUnfixable", () => {
  afterEach(() => vi.unstubAllGlobals());

  const client = () =>
    new RemoteHostClient({ hostId: "h1", baseUrl: "http://example.invalid:1234/", token: "tok" });
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  it("GETs /internal/task-ci-unfixable and unwraps { content }", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { content: "outage" }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(client().resolveReadTaskCiUnfixable(7, HEAD)).resolves.toBe("outage");
    expect(fetchMock).toHaveBeenCalledWith(
      `http://example.invalid:1234/internal/task-ci-unfixable?taskId=7&headSha=${HEAD}`,
      expect.anything(),
    );
  });

  it("resolves null for an absent file, and throws (not null) on a 404 from an old peer", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { content: null })));
    await expect(client().resolveReadTaskCiUnfixable(7, HEAD)).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("nf", { status: 404 })));
    await expect(client().resolveReadTaskCiUnfixable(7, HEAD)).rejects.toThrow(HostRequestError);
  });
});

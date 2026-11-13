import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";

// The agent's GET /internal/fs/dirs (the proxy target of the primary's
// GET /api/fs/dirs?hostId=…) and the RemoteHostClient method that calls it.
const TOKEN = "fs-dirs-agent-token";
const headers = { authorization: `Bearer ${TOKEN}` };

describe("GET /internal/fs/dirs (agent role)", () => {
  let dir: string;

  beforeAll(() => {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = TOKEN;
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "internal-fs-dirs-")));
    fs.mkdirSync(path.join(dir, "child"));
    fs.writeFileSync(path.join(dir, "file.txt"), "x");
  });

  afterAll(() => {
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_AGENT_TOKEN;
    fs.rmSync(dir, { recursive: true, force: true });
    closeDb();
  });

  it("lists sub-directories anywhere on this host, not only under PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/internal/fs/dirs?path=${encodeURIComponent(dir)}`,
      headers,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().directories).toEqual([{ name: "child", path: path.join(dir, "child") }]);
    await app.close();
  });

  it("maps a missing directory to 404 and a relative path to 400", async () => {
    const app = await buildApp();
    const missing = await app.inject({
      method: "GET",
      url: `/internal/fs/dirs?path=${encodeURIComponent("/definitely/not/here")}`,
      headers,
    });
    expect(missing.statusCode).toBe(404);
    const relative = await app.inject({
      method: "GET",
      url: "/internal/fs/dirs?path=relative",
      headers,
    });
    expect(relative.statusCode).toBe(400);
    await app.close();
  });

  it("requires the agent token", async () => {
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/internal/fs/dirs?path=%2F" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("RemoteHostClient.listDirectories", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requests /internal/fs/dirs with the path encoded and the hidden flag", async () => {
    const listing = { path: "/srv", parent: "/", directories: [], truncated: false };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(listing), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = new RemoteHostClient({
      hostId: "h1",
      baseUrl: "http://example.invalid:1234/",
      token: "tok",
    });
    await expect(client.listDirectories("/srv/a b", true)).resolves.toEqual(listing);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://example.invalid:1234/internal/fs/dirs?path=%2Fsrv%2Fa%20b&hidden=1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer tok" }),
      }),
    );
  });
});

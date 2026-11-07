import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import { HostBusyError, HostRequestError } from "../../src/services/remote-host-errors.js";

// A remote project's preview answers a saturated channel (the preview cap, or
// no free slot) with 503 + Retry-After and an over-limit body with 413, not a
// blanket 502 PREVIEW_UNAVAILABLE.
const tmpDb = path.join(os.tmpdir(), `preview-proxy-busy-${process.pid}.db`);
const PREVIEW_BASE_HOST = "preview.busy.test";

describe("preview proxy: busy and over-limit agent channel", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.PREVIEW_BASE_HOST = PREVIEW_BASE_HOST;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.PREVIEW_BASE_HOST;
  });

  it.each([
    ["a saturated channel", () => new HostBusyError("h"), 503, "1"],
    ["an over-limit request body", () => new HostRequestError("h", 413, "too big"), 413, undefined],
  ])("answers %s explicitly rather than with a blanket 502", async (_n, makeErr, status, retry) => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-busy", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: {
        allowDuplicate: true,
        name: "remote-busy-test",
        cwd: "/x",
        hostId: host.json().id,
      },
    });
    const projectId = created.json().id as number;
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${projectId}`,
      payload: { devServerUrl: "5173" },
    });
    const preview = await app.inject({
      method: "POST",
      url: "/api/previews",
      payload: { kind: "project", projectId },
    });
    const slug = preview.json().slug as string;
    const spy = vi
      .spyOn(RemoteHostClient.prototype, "openPreviewHttp")
      .mockRejectedValue(makeErr());

    const res = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: `preview-${slug}.${PREVIEW_BASE_HOST}` },
    });
    spy.mockRestore();
    expect(res.statusCode).toBe(status);
    expect(res.headers["retry-after"]).toBe(retry);
    await app.close();
  });
});

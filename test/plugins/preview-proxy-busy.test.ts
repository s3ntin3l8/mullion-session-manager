import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { RemoteHostClient } from "../../src/services/remote-host-client.js";
import {
  HostBusyError,
  HostRequestError,
  HostResponseTooLargeError,
} from "../../src/services/remote-host-errors.js";
import { createMuxConnection } from "../../src/services/ssh-agent-mux.js";
import { bindChannelHost, unbindChannelHost } from "../../src/services/agent-channel-tunnel.js";

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
    ["a saturated channel", () => new HostBusyError("h"), 503, "1", /preview unavailable/],
    [
      "an over-limit request body",
      () => new HostRequestError("h", 413, "too big"),
      413,
      undefined,
      /preview unavailable/,
    ],
    // The dev server's response outgrew the limit: the upstream's doing, not a 413 for the browser.
    [
      "an over-limit upstream response",
      () => new HostResponseTooLargeError("h", "big"),
      502,
      undefined,
      /response is too large/,
    ],
  ])(
    "answers %s explicitly rather than with a blanket 502",
    async (_n, makeErr, status, retry, body) => {
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
      // The message tells the three apart: a bare status would not.
      expect(res.json().message).toMatch(body);
      await app.close();
    },
  );

  it("answers 503 + Retry-After through the real mux and client once the preview cap is full (#2702)", async () => {
    const app = await buildApp();
    const host = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: "remote-cap", baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = host.json().id as string;
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "remote-cap-test", cwd: "/x", hostId },
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

    // A real mux pair whose peer accepts every channel and never answers: the
    // first preview holds the only preview slot.
    const { primarySocket, agentSocket } = linkedSockets();
    const primaryMux = createMuxConnection(primarySocket as never, {
      channelIdParity: "even",
      maxChannels: 8,
      maxStreamChannels: 4,
      maxPreviewChannels: 1,
    });
    const agentMux = createMuxConnection(agentSocket as never, {
      channelIdParity: "odd",
      maxChannels: 8,
    });
    agentMux.onChannel(() => undefined);
    app.agentChannels.set(hostId, {
      hostId,
      carriedOperations: ["channel-requests"],
      negotiatedOperations: ["channel-requests"],
      terminal: null,
      mux: primaryMux,
      connectedAt: Date.now(),
    } as never);
    bindChannelHost(app, hostId);
    const headers = { host: `preview-${slug}.${PREVIEW_BASE_HOST}` };
    try {
      const first = app.inject({ method: "GET", url: "/a", headers });
      await vi.waitFor(() => expect(primaryMux.openChannelCount).toBe(1));
      const second = await app.inject({ method: "GET", url: "/b", headers });
      expect(second.statusCode).toBe(503);
      expect(second.headers["retry-after"]).toBe("1");
      primaryMux.close();
      agentMux.close();
      await first;
    } finally {
      unbindChannelHost(app, hostId);
      app.agentChannels.delete(hostId);
      await app.close();
    }
  });
});

/** Two minimal linked websocket stand-ins for a mux pair. */
function linkedSockets() {
  class Sock {
    readyState = 1;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSING = 2;
    readonly CLOSED = 3;
    peer: Sock | null = null;
    private listeners = new Map<string, Array<(...a: never[]) => void>>();
    on(event: string, l: (...a: never[]) => void) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    }
    emit(event: string, ...args: unknown[]) {
      for (const l of this.listeners.get(event) ?? []) (l as (...a: unknown[]) => void)(...args);
    }
    send(data: Buffer) {
      this.peer?.emit("message", data, true);
    }
    close() {
      if (this.readyState === this.CLOSED) return;
      this.readyState = this.CLOSED;
      this.emit("close", 1000, Buffer.alloc(0));
      this.peer?.close();
    }
    terminate() {
      this.close();
    }
  }
  const primarySocket = new Sock();
  const agentSocket = new Sock();
  primarySocket.peer = agentSocket;
  agentSocket.peer = primarySocket;
  return { primarySocket, agentSocket };
}

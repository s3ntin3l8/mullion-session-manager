import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { MullionClient } from "../../src/mcp/client.mjs";

// Issue #271 — mirrors test/hooks/forwarder.test.ts's "real socket, real
// client" posture for MullionClient.promoteRequest, the transport half of
// the `mullion mcp` server's `promote_to_worktree` tool.

function listen(socketPath: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.removeListener("error", reject);
      resolve(server);
    });
  });
}

describe("MullionClient (issue #271)", () => {
  let dir: string;
  let server: net.Server | null = null;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  describe("isConfigured", () => {
    it("is false when the hook socket env vars are absent", () => {
      expect(new MullionClient({}).isConfigured()).toBe(false);
    });

    it("is true when both hook socket env vars are present", () => {
      expect(
        new MullionClient({
          MULLION_HOOK_SOCKET: "/tmp/x.sock",
          MULLION_HOOK_TOKEN: "tok",
        }).isConfigured(),
      ).toBe(true);
    });

    it("is false when either var is an empty string, not just absent", () => {
      expect(
        new MullionClient({ MULLION_HOOK_SOCKET: "", MULLION_HOOK_TOKEN: "tok" }).isConfigured(),
      ).toBe(false);
      expect(
        new MullionClient({
          MULLION_HOOK_SOCKET: "/tmp/x.sock",
          MULLION_HOOK_TOKEN: "",
        }).isConfigured(),
      ).toBe(false);
    });
  });

  describe("promoteRequest", () => {
    it("resolves declined without connecting anywhere when not configured", async () => {
      const client = new MullionClient({});
      const result = await client.promoteRequest("summary", undefined);
      expect(result.decision).toBe("declined");
      expect(result.reason).toContain("MULLION_HOOK_SOCKET");
    });

    it("handshakes, sends a promote_request message, and resolves an accepted decision", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-client-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            const line = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 1) expect(JSON.parse(line)).toEqual({ token: "tok-123" });
            if (lines === 2) {
              expect(JSON.parse(line)).toEqual({
                kind: "promote_request",
                summary: "start work",
                suggestedBaseRef: "main",
              });
              socket.write(
                `${JSON.stringify({
                  decision: "accepted",
                  worktreePath: "/tmp/.mullion-worktrees/foo",
                  newSessionId: 7,
                })}\n`,
              );
            }
          }
        });
      });

      const client = new MullionClient({
        MULLION_HOOK_SOCKET: socketPath,
        MULLION_HOOK_TOKEN: "tok-123",
      });
      const result = await client.promoteRequest("start work", "main");
      expect(result).toEqual({
        decision: "accepted",
        worktreePath: "/tmp/.mullion-worktrees/foo",
        newSessionId: 7,
      });
    });

    it("resolves declined with the server's reason", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-client-decline-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) {
              socket.write(`${JSON.stringify({ decision: "declined", reason: "not now" })}\n`);
            }
          }
        });
      });

      const client = new MullionClient({
        MULLION_HOOK_SOCKET: socketPath,
        MULLION_HOOK_TOKEN: "tok-123",
      });
      const result = await client.promoteRequest("start work", undefined);
      expect(result).toEqual({ decision: "declined", reason: "not now" });
    });

    it("resolves declined (never rejects) when the connection closes before any reply", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-client-close-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.destroy();
          }
        });
      });

      const client = new MullionClient({
        MULLION_HOOK_SOCKET: socketPath,
        MULLION_HOOK_TOKEN: "tok-123",
      });
      const result = await client.promoteRequest("start work", undefined);
      expect(result.decision).toBe("declined");
    });

    it("resolves declined (never rejects) when the socket path doesn't exist", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-client-noexist-"));
      const client = new MullionClient({
        MULLION_HOOK_SOCKET: path.join(dir, "no-such.sock"),
        MULLION_HOOK_TOKEN: "tok",
      });
      const result = await client.promoteRequest("start work", undefined);
      expect(result.decision).toBe("declined");
    });

    it("resolves declined on a reply that isn't valid JSON", async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-client-malformed-"));
      const socketPath = path.join(dir, "hooks.sock");
      server = await listen(socketPath);

      server.once("connection", (socket) => {
        let buffer = "";
        let lines = 0;
        socket.on("data", (chunk: Buffer) => {
          buffer += chunk.toString("utf8");
          while (buffer.includes("\n")) {
            const idx = buffer.indexOf("\n");
            buffer = buffer.slice(idx + 1);
            lines++;
            if (lines === 2) socket.write("not json at all\n");
          }
        });
      });

      const client = new MullionClient({
        MULLION_HOOK_SOCKET: socketPath,
        MULLION_HOOK_TOKEN: "tok-123",
      });
      const result = await client.promoteRequest("start work", undefined);
      expect(result.decision).toBe("declined");
    });
  });

  describe("control-socket ops (issue #134 part 2)", () => {
    /** Reads line-buffered NDJSON off a server-side connection, invoking
     * `onMessage` once per parsed JSON line — mirrors control-socket.ts's own
     * line-buffering, same helper test/cli/client.test.ts uses. */
    function readLines(socket: net.Socket, onMessage: (msg: unknown) => void): void {
      let buffer = "";
      socket.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let idx = buffer.indexOf("\n");
        while (idx !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          idx = buffer.indexOf("\n");
          if (line.trim() === "") continue;
          onMessage(JSON.parse(line));
        }
      });
    }

    async function startControlServer(
      onRequest: (msg: { id: number; op: string; body: unknown }, socket: net.Socket) => void,
    ) {
      dir = mkdtempSync(path.join(os.tmpdir(), "mullion-mcp-control-"));
      const socketPath = path.join(dir, "mullion.sock");
      server = await listen(socketPath);
      server.on("connection", (socket) => {
        let handshaked = false;
        readLines(socket, (msg) => {
          if (!handshaked) {
            handshaked = true;
            return;
          }
          onRequest(msg as { id: number; op: string; body: unknown }, socket);
        });
      });
      return socketPath;
    }

    it("listSessions sends sessions.list with the given filters and returns the result", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.list");
        expect(msg.body).toEqual({ projectId: "3", kind: "dock" });
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [{ id: 1 }] })}\n`,
        );
      });
      const client = new MullionClient({
        MULLION_SOCKET_PATH: socketPath,
        MULLION_HOOK_TOKEN: "tok",
      });
      const result = await client.listSessions({ projectId: "3", kind: "dock" });
      expect(result).toEqual([{ id: 1 }]);
    });

    it("listProjects sends projects.list with an empty body", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.list");
        expect(msg.body).toEqual({});
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.listProjects()).toEqual([]);
    });

    it("listActions omits projectId from the body when not given", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.actions");
        expect(msg.body).toEqual({});
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.listActions(undefined);
    });

    it("getScrollback omits sessionId from the body when not given", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.scrollback");
        expect(msg.body).toEqual({});
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { b64: "" } })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.getScrollback(undefined)).toEqual({ b64: "" });
    });

    it("stopDockSession sends sessions.kill with the given sessionId", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.kill");
        expect(msg.body).toEqual({ sessionId: "9" });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.stopDockSession("9");
    });

    it("createPreview sends kind:project when projectId is given", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("previews.create");
        expect(msg.body).toEqual({ kind: "project", projectId: "3" });
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { slug: "abc" } })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.createPreview({ projectId: "3", url: undefined })).toEqual({
        slug: "abc",
      });
    });

    it("createPreview sends kind:external when url is given", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("previews.create");
        expect(msg.body).toEqual({ kind: "external", url: "http://example.com" });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 201, result: {} })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.createPreview({ projectId: undefined, url: "http://example.com" });
    });

    it("createPreview throws when neither projectId nor url is given, without connecting anywhere", async () => {
      const client = new MullionClient({ MULLION_SOCKET_PATH: "/nonexistent.sock" });
      await expect(client.createPreview({ projectId: undefined, url: undefined })).rejects.toThrow(
        "one of projectId or url is required",
      );
    });

    it("createPreview throws when both projectId and url are given, without connecting anywhere", async () => {
      const client = new MullionClient({ MULLION_SOCKET_PATH: "/nonexistent.sock" });
      await expect(
        client.createPreview({ projectId: "3", url: "http://example.com" }),
      ).rejects.toThrow("projectId and url are mutually exclusive");
    });

    it("deletePreview sends previews.delete with the given slug", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("previews.delete");
        expect(msg.body).toEqual({ slug: "abc" });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.deletePreview("abc");
    });

    it("listPreviews sends previews.list with an empty body", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("previews.list");
        expect(msg.body).toEqual({});
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [{ slug: "abc" }] })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.listPreviews()).toEqual([{ slug: "abc" }]);
    });

    it("startDockSession resolves the dock control via projects.dock, then creates a dock session", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        if (msg.op === "projects.dock") {
          expect(msg.body).toEqual({ projectId: "3" });
          socket.write(
            `${JSON.stringify({
              id: msg.id,
              ok: true,
              status: 200,
              result: [{ id: "vite", command: "npm run dev", title: "Vite", cwd: "/app" }],
            })}\n`,
          );
          return;
        }
        expect(msg.op).toBe("sessions.create");
        expect(msg.body).toEqual({
          projectId: "3",
          command: "npm run dev",
          kind: "dock",
          name: "Vite",
          cwd: "/app",
        });
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 42 } })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      const result = await client.startDockSession("3", "vite");
      expect(result).toEqual({ id: 42 });
    });

    it("startDockSession throws a clear error when the dock control id doesn't exist", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await expect(client.startDockSession("3", "missing")).rejects.toThrow(
        "no dock control 'missing' for project 3",
      );
    });

    it("propagates a control-socket error (e.g. scope 403) to the caller", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        socket.write(
          `${JSON.stringify({
            id: msg.id,
            ok: false,
            status: 403,
            error: "not permitted for this connection's scope",
          })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await expect(client.listSessions()).rejects.toMatchObject({
        status: 403,
        message: "not permitted for this connection's scope",
      });
    });
  });
});

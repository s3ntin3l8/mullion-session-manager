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
});

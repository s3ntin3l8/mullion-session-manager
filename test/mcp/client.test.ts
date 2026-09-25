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

    // Phase 5 (Track B, issue #193 5.3b).
    it("spawnChildSession sends sessions.spawn_child with only the given fields", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.spawn_child");
        expect(msg.body).toEqual({ command: "bash" });
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 5 } })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.spawnChildSession({ command: "bash" })).toEqual({ id: 5 });
    });

    it("spawnChildSession forwards optional fields including an explicit parentSessionId", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.spawn_child");
        expect(msg.body).toEqual({
          command: "claude",
          name: "reviewer",
          cwd: "/tmp/proj",
          kind: "terminal",
          skipPermissions: true,
          parentSessionId: "9",
        });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 201 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.spawnChildSession({
        command: "claude",
        name: "reviewer",
        cwd: "/tmp/proj",
        kind: "terminal",
        skipPermissions: true,
        parentSessionId: "9",
      });
    });

    // Root-cause fix for the opencode `command`-embedded-prompt trap. Sent
    // over the wire as `seedPrompt`, not `initialPrompt` — POST
    // /api/sessions' own field name for this (routes/sessions.ts's
    // createSessionSchema), which the route handler translates into a real
    // argv turn only when the target command's hook adapter supports it.
    it("spawnChildSession sends an initialPrompt arg as seedPrompt on the wire", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("sessions.spawn_child");
        expect(msg.body).toEqual({ command: "opencode", seedPrompt: "do the thing" });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 201 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.spawnChildSession({ command: "opencode", initialPrompt: "do the thing" });
    });

    // Issue #1291 — ownSessionId (MULLION_SESSION_ID) fallback, for the
    // auth-disabled-host case where the control socket itself has no
    // pinned session to resolve "self" from. Hermes review, PR #1292: the
    // fallback is a RETRY on the specific "no pin" 400, never an eager
    // substitution — so every "falls back" test below drives a first
    // failing attempt, and a companion "does not retry" test locks in
    // that the already-working (real session-scope) case takes no extra
    // round trip at all.
    describe("ownSessionId fallback (issue #1291)", () => {
      it("getScrollback retries with MULLION_SESSION_ID after the direct attempt 400s", async () => {
        let calls = 0;
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("sessions.scrollback");
          calls += 1;
          if (calls === 1) {
            expect(msg.body).toEqual({});
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "'sessionId' is required" })}\n`,
            );
            return;
          }
          expect(msg.body).toEqual({ sessionId: "42" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { b64: "" } })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.getScrollback(undefined);
        expect(calls).toBe(2);
      });

      it("getScrollback does not retry when the direct attempt already succeeds", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.body).toEqual({});
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { b64: "" } })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.getScrollback(undefined);
      });

      it("getScrollback prefers an explicit sessionId over MULLION_SESSION_ID", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.body).toEqual({ sessionId: "7" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { b64: "" } })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.getScrollback("7");
      });

      it("spawnChildSession retries with MULLION_SESSION_ID after the direct attempt 400s", async () => {
        let calls = 0;
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("sessions.spawn_child");
          calls += 1;
          if (calls === 1) {
            expect(msg.body).toEqual({ command: "bash" });
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "'parentSessionId' is required" })}\n`,
            );
            return;
          }
          expect(msg.body).toEqual({ command: "bash", parentSessionId: "42" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 5 } })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.spawnChildSession({ command: "bash" });
        expect(calls).toBe(2);
      });

      it("spawnChildSession does not retry when the direct attempt already succeeds", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.body).toEqual({ command: "bash" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 5 } })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.spawnChildSession({ command: "bash" });
      });

      // Hermes review, PR #1292 — the fallback must only fire after the
      // direct (empty-body) attempt actually fails with the "no pin"
      // 400, never unconditionally, so the already-working session-scope
      // path never pays for or risks the sessions.get-derived lookup.
      it("listActions retries via sessions.get only after the direct attempt 400s", async () => {
        let actionsCalls = 0;
        const socketPath = await startControlServer((msg, socket) => {
          if (msg.op === "sessions.get") {
            expect(msg.body).toEqual({ sessionId: "42" });
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { id: 42, projectId: 3 } })}\n`,
            );
            return;
          }
          expect(msg.op).toBe("projects.actions");
          actionsCalls += 1;
          if (actionsCalls === 1) {
            expect(msg.body).toEqual({});
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "'projectId' is required" })}\n`,
            );
            return;
          }
          expect(msg.body).toEqual({ projectId: "3" });
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.listActions(undefined);
        expect(actionsCalls).toBe(2);
      });

      it("listActions does not retry when the direct attempt already succeeds", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("projects.actions");
          expect(msg.body).toEqual({});
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
        });
        // MULLION_SESSION_ID is set (as it always is inside a real session),
        // but with no failure to recover from, sessions.get must never fire —
        // this is the genuinely-session-scoped case working exactly as it
        // did before this fix, no extra round trip at all.
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await client.listActions(undefined);
      });

      it("listActions rethrows the original 400 when its own session has no project", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          if (msg.op === "sessions.get") {
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { id: 42, projectId: null } })}\n`,
            );
            return;
          }
          expect(msg.op).toBe("projects.actions");
          expect(msg.body).toEqual({});
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "'projectId' is required" })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await expect(client.listActions(undefined)).rejects.toThrow("'projectId' is required");
      });

      // Hermes review, PR #1292 — the retry must key off the exact
      // "no pin" message, not just "any 400", so an unrelated 400 doesn't
      // trigger a sessions.get lookup and mask the real error behind a
      // different one.
      it("listActions does not retry on an unrelated 400", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("projects.actions");
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "something else entirely" })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await expect(client.listActions(undefined)).rejects.toThrow("something else entirely");
      });

      // Hermes review, PR #1292 — the sessions.get lookup itself can fail
      // (e.g. a stale/deleted MULLION_SESSION_ID); that failure must not
      // mask the canonical "'projectId' is required" this whole retry
      // exists to recover from.
      it("listActions rethrows the original 400 when the sessions.get lookup itself fails", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          if (msg.op === "sessions.get") {
            socket.write(
              `${JSON.stringify({ id: msg.id, ok: false, status: 404, error: "session not found" })}\n`,
            );
            return;
          }
          expect(msg.op).toBe("projects.actions");
          expect(msg.body).toEqual({});
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: false, status: 400, error: "'projectId' is required" })}\n`,
          );
        });
        const client = new MullionClient({
          MULLION_SOCKET_PATH: socketPath,
          MULLION_SESSION_ID: "42",
        });
        await expect(client.listActions(undefined)).rejects.toThrow("'projectId' is required");
      });
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

    it("startDockSession names a docker-sourced control's session by its stable containerName identity, not its title", async () => {
      // Issue #73 follow-up plan (5b) — `control.command` for a docker
      // control is reconstructed fresh from live container labels on every
      // discovery poll and can change text without the service having
      // changed, so naming the session by `control.title` (or matching by
      // command) can silently orphan it. `docker-logs:<containerName>`
      // mirrors dockHelpers.ts's own dockerSessionIdentity on the frontend.
      const socketPath = await startControlServer((msg, socket) => {
        if (msg.op === "projects.dock") {
          socket.write(
            `${JSON.stringify({
              id: msg.id,
              ok: true,
              status: 200,
              result: [
                {
                  id: "docker:sanctuary:web",
                  command: "docker compose -p sanctuary logs -f web",
                  title: "web",
                  source: "docker",
                  docker: { containerName: "sanctuary-web" },
                },
              ],
            })}\n`,
          );
          return;
        }
        expect(msg.op).toBe("sessions.create");
        expect(msg.body).toEqual({
          projectId: "3",
          command: "docker compose -p sanctuary logs -f web",
          kind: "dock",
          name: "docker-logs:sanctuary-web",
          nameLocked: true,
        });
        socket.write(
          `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 42 } })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.startDockSession("3", "docker:sanctuary:web");
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

    it("getProjectTooling sends projects.get_tooling with the given projectId", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.get_tooling");
        expect(msg.body).toEqual({ projectId: "3" });
        socket.write(
          `${JSON.stringify({
            id: msg.id,
            ok: true,
            status: 200,
            result: { briefing: "hi", skill: null, reviewerAgent: null },
          })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      expect(await client.getProjectTooling("3")).toEqual({
        briefing: "hi",
        skill: null,
        reviewerAgent: null,
      });
    });

    it("getProjectTooling omits projectId from the body when not given", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.get_tooling");
        expect(msg.body).toEqual({ projectId: undefined });
        socket.write(
          `${JSON.stringify({
            id: msg.id,
            ok: true,
            status: 200,
            result: { briefing: null, skill: null, reviewerAgent: null },
          })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.getProjectTooling(undefined);
    });

    it("setProjectTooling sends only the provided fields", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.set_tooling");
        expect(msg.body).toEqual({ projectId: "3", briefing: "x" });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.setProjectTooling({ projectId: "3", briefing: "x" });
    });

    it("setProjectTooling forwards all three fields when all are provided", async () => {
      const socketPath = await startControlServer((msg, socket) => {
        expect(msg.op).toBe("projects.set_tooling");
        expect(msg.body).toEqual({
          projectId: "3",
          briefing: "b",
          skill: "s",
          reviewerAgent: "r",
        });
        socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200 })}\n`);
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await client.setProjectTooling({
        projectId: "3",
        briefing: "b",
        skill: "s",
        reviewerAgent: "r",
      });
    });

    it("setProjectTooling rejects on ok:false (the control client surfaces that as a generic error)", async () => {
      // The control client's _route rejects on `ok: false` so the MCP
      // tool sees a MullionSocketError; the per-field results that the
      // control-socket op attaches for partial-failure diagnostics are
      // intentionally NOT exposed through the MCP client (that pathway
      // is exercised at the control-socket layer instead). This is the
      // MCP-client contract; if a caller needs per-field detail, the
      // CLI is the right surface.
      const socketPath = await startControlServer((msg, socket) => {
        socket.write(
          `${JSON.stringify({
            id: msg.id,
            ok: false,
            status: 400,
            error: "validation failed",
          })}\n`,
        );
      });
      const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
      await expect(
        client.setProjectTooling({ projectId: "3", briefing: "x" }),
      ).rejects.toMatchObject({ status: 400, message: "validation failed" });
    });

    describe("device methods (PR #1324)", () => {
      it("listDevices calls device.list", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.list");
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 200, result: [] })}\n`);
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        const result = await client.listDevices();
        expect(result).toEqual([]);
      });

      it("getDevice calls device.get with deviceId", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.get");
          expect(msg.body).toEqual({ deviceId: "42" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { id: 42 } })}\n`,
          );
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        const result = await client.getDevice("42");
        expect(result).toEqual({ id: 42 });
      });

      it("createDevice calls device.create with body", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.create");
          expect(msg.body).toEqual({ avdName: "dev35" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 201, result: { id: 1 } })}\n`,
          );
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        const result = await client.createDevice({ avdName: "dev35" });
        expect(result).toEqual({ id: 1 });
      });

      it("startDevice calls device.start with deviceId", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.start");
          expect(msg.body).toEqual({ deviceId: "1" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { id: 1, status: "active" } })}\n`,
          );
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        const result = await client.startDevice("1");
        expect(result).toEqual({ id: 1, status: "active" });
      });

      it("deleteDevice calls device.delete with deviceId", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.delete");
          expect(msg.body).toEqual({ deviceId: "1" });
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 204 })}\n`);
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        await client.deleteDevice("1");
      });

      // `device.terminate` still names the op, but control-socket.ts now
      // dispatches it to POST /:id/stop (reversible, row kept) — see the
      // method's own doc comment in src/mcp/client.mjs. `stop_device` is
      // the MCP tool name; this stays the only client method for it.
      it("terminateDevice calls device.terminate with deviceId (the stop path)", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.terminate");
          expect(msg.body).toEqual({ deviceId: "1" });
          socket.write(`${JSON.stringify({ id: msg.id, ok: true, status: 204 })}\n`);
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        await client.terminateDevice("1");
      });

      it("deviceAction calls device.action with deviceId and actionPayload", async () => {
        const socketPath = await startControlServer((msg, socket) => {
          expect(msg.op).toBe("device.action");
          expect(msg.body).toEqual({ deviceId: "1", action: "screenshot" });
          socket.write(
            `${JSON.stringify({ id: msg.id, ok: true, status: 200, result: { screenshot: "abc" } })}\n`,
          );
        });
        const client = new MullionClient({ MULLION_SOCKET_PATH: socketPath });
        const result = await client.deviceAction("1", { action: "screenshot" });
        expect(result).toEqual({ screenshot: "abc" });
      });
    });
  });
});

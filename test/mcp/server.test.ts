import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

// Issue #271 — integration test for the real server.mjs subprocess entry
// point (the thin JSON-RPC/stdio shim that tools.test.ts/client.test.ts
// can't reach), mirroring test/hooks/forwarder.test.ts's "spawn the real
// child process" posture. Deliberately runs with the hook-socket env vars
// UNSET (or pointed at a nonexistent path) — this file must never
// accidentally connect to a real Mullion instance's own hook socket if one
// happens to be set in the ambient environment (see the header comment on
// why this matters: a real listener that doesn't understand
// `promote_request` would hang the tools/call response until this client's
// own timeout, not a fast, deterministic test).

const SERVER_PATH = fileURLToPath(new URL("../../src/mcp/server.mjs", import.meta.url));

function send(child: ChildProcessWithoutNullStreams, message: unknown) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Reads newline-delimited JSON-RPC responses off stdout, resolving each
 * `waitForId` promise as its id arrives. */
class ResponseReader {
  private buffer = "";
  private byId = new Map<number, unknown>();
  private waiters = new Map<number, (value: unknown) => void>();

  constructor(child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let idx = this.buffer.indexOf("\n");
      while (idx !== -1) {
        const line = this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + 1);
        idx = this.buffer.indexOf("\n");
        if (line.trim() === "") continue;
        const parsed = JSON.parse(line);
        if (typeof parsed.id === "number") {
          const waiter = this.waiters.get(parsed.id);
          if (waiter) {
            waiter(parsed);
            this.waiters.delete(parsed.id);
          } else {
            this.byId.set(parsed.id, parsed);
          }
        }
      }
    });
  }

  waitForId(id: number): Promise<{
    jsonrpc: string;
    id: number;
    result?: unknown;
    error?: { code: number; message: string };
  }> {
    if (this.byId.has(id)) {
      const value = this.byId.get(id);
      this.byId.delete(id);
      return Promise.resolve(value as never);
    }
    return new Promise((resolve) => this.waiters.set(id, resolve as never));
  }
}

/**
 * Spawns the real server.mjs. Always strips MULLION_HOOK_SOCKET/
 * MULLION_HOOK_TOKEN from the inherited environment first — this test
 * process itself may be running inside a real Mullion session (with its
 * own real hook socket set), and an empty-string override (rather than a
 * true deletion) still satisfies MullionClient.isConfigured()'s
 * `typeof === "string"` check, causing a real `net.createConnection("")`
 * attempt instead of the clean "not configured" no-op path these tests
 * need. `env` supplies genuine overrides on top of that clean base.
 */
function spawnServer(env: NodeJS.ProcessEnv = {}): ChildProcessWithoutNullStreams {
  const base = { ...process.env };
  delete base.MULLION_HOOK_SOCKET;
  delete base.MULLION_HOOK_TOKEN;
  return spawn(process.execPath, [SERVER_PATH], {
    env: { ...base, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

describe("mcp/server.mjs (issue #271)", () => {
  let child: ChildProcessWithoutNullStreams | null = null;

  afterEach(() => {
    child?.kill();
    child = null;
  });

  it("responds to initialize with protocolVersion, tools capability, and serverInfo", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      },
    });

    const response = await reader.waitForId(1);
    expect(response.result).toMatchObject({
      protocolVersion: "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: "mullion" },
    });
  });

  it("sends no response to notifications/initialized (a notification, no id)", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
    // Confirm the server is still alive/responsive afterward instead — a
    // hung or crashed process would fail this follow-up call.
    send(child, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const response = await reader.waitForId(2);
    expect(response.result).toBeDefined();
  });

  it("lists promote_to_worktree via tools/list", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, { jsonrpc: "2.0", id: 1, method: "tools/list" });

    const response = await reader.waitForId(1);
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(["promote_to_worktree"]);
  });

  it("tools/call for promote_to_worktree with no hook socket configured returns a declined, non-error result", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "promote_to_worktree", arguments: { summary: "start work" } },
    });

    const response = await reader.waitForId(1);
    const result = response.result as {
      content: Array<{ type: string; text: string }>;
      isError: boolean;
    };
    expect(result.isError).toBe(false);
    expect(result.content[0].text).toContain("Declined");
  });

  it("tools/call for an unknown tool returns isError: true, not a protocol error", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    });

    const response = await reader.waitForId(1);
    const result = response.result as { content: Array<{ text: string }>; isError: boolean };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("no_such_tool");
  });

  it("responds with a JSON-RPC 'Method not found' error for an unsupported method", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    send(child, { jsonrpc: "2.0", id: 1, method: "resources/list" });

    const response = await reader.waitForId(1);
    expect(response.error).toMatchObject({ code: -32601 });
  });

  it("ignores a malformed (non-JSON) line without crashing, and keeps responding to later requests", async () => {
    child = spawnServer();
    const reader = new ResponseReader(child);
    child.stdin.write("not json at all\n");
    send(child, { jsonrpc: "2.0", id: 1, method: "tools/list" });

    const response = await reader.waitForId(1);
    expect(response.result).toBeDefined();
  });
});

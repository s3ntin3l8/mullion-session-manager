import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Issue #2639 — an agent host has no database; its hook-socket browser serves
// exactly the target the primary sent at spawn, never one derived from the
// session's cwd. Same real-socket + faked node-pty/child_process setup as
// hooks.test.ts.
class FakePty {
  onData() {
    return { dispose: () => {} };
  }
  onExit() {
    return { dispose: () => {} };
  }
  write() {}
  resize() {}
  kill() {}
}

vi.mock("node-pty", () => ({
  spawn: vi.fn(() => new FakePty()),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      setImmediate(() => ee.emit("exit", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { rememberSessionBrowserTarget } =
  await import("../../src/services/session-browser-targets.js");
const { identityStatePath } = await import("../../src/services/agent-identity.js");

function connect(path: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path);
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
  });
}

function waitForLine(socket: net.Socket): Promise<string> {
  return new Promise((resolve) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex !== -1) resolve(buffer.slice(0, newlineIndex));
    });
  });
}

describe("hook-socket browser on an agent host (issue #2639)", () => {
  let app: Awaited<ReturnType<typeof buildApp>> | null = null;
  const savedEnv = {
    MULLION_ROLE: process.env.MULLION_ROLE,
    MULLION_AGENT_TOKEN: process.env.MULLION_AGENT_TOKEN,
  };

  afterEach(async () => {
    if (app) await app.close();
    app = null;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    delete process.env.BROWSER_ENABLED;
  });

  async function agentSession(
    browserTarget?: { projectId: number; hostId: string; checkoutRoot: string; legacy: boolean },
    prepare?: (a: NonNullable<typeof app>) => void,
    opts: { remember?: boolean } = {},
  ) {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_AGENT_TOKEN = "agent-hook-test-token";
    process.env.BROWSER_ENABLED = "true";
    app = await buildApp();
    await app.ready();
    prepare?.(app);
    const session = app.pty.getOrCreate({
      id: "321",
      cwd: "/work/p/sub",
      command: "bash",
      cols: 80,
      rows: 24,
      projectId: 7,
    });
    if (opts.remember !== false) rememberSessionBrowserTarget(app.pty, "321", browserTarget);
    const socket = await connect(app.pty.hookSocketPath);
    socket.write(`${JSON.stringify({ token: session.hookToken })}\n`);
    const replyPromise = waitForLine(socket);
    socket.write(`${JSON.stringify({ kind: "browser_action", action: "get" })}\n`);
    const reply = JSON.parse(await replyPromise);
    socket.destroy();
    return reply;
  }

  it("drives the primary's target, not one derived from the session's cwd", async () => {
    const target = { projectId: 7, hostId: "agent-1", checkoutRoot: "/work/p", legacy: true };
    const launch = vi.fn();
    const reply = await agentSession(target, (a) => {
      launch.mockResolvedValue({
        page: {
          url: () => "about:blank",
          title: async () => "t",
          content: async () => "<html></html>",
          evaluate: async () => null,
          locator: () => ({ ariaSnapshot: async () => "- body", all: async () => [] }),
        },
        consoleLogs: [],
        pageErrors: [],
      });
      vi.spyOn(a.browser, "getOrLaunch").mockImplementation(
        launch as unknown as typeof a.browser.getOrLaunch,
      );
    });
    expect(reply.error).toBeUndefined();
    // The exact object the primary sent: the project root with the legacy
    // flag, not `{ checkoutRoot: "/work/p/sub", legacy: false }`.
    expect(launch).toHaveBeenCalledWith(target);
  });

  it("refuses a target that names another host once the agent knows its own id", async () => {
    const statePath = identityStatePath(process.env.SESSIONS_DIR!);
    fs.writeFileSync(
      statePath,
      JSON.stringify({ hostId: "agent-own", machineCredential: "c".repeat(32) }),
    );
    try {
      const reply = await agentSession({
        projectId: 7,
        hostId: "agent-1",
        checkoutRoot: "/work/p",
        legacy: true,
      });
      expect(reply.error).toMatch(/another host/);
    } finally {
      fs.rmSync(statePath, { force: true });
    }
  });

  it("keeps use_browser for a session whose agent restarted (#2672)", async () => {
    // The target was written by the previous agent process; this one never
    // saw the spawn (the session survived in dtach) and loads it from disk.
    const file = path.join(process.env.SESSIONS_DIR!, "browser-targets.json");
    const target = { projectId: 7, hostId: "agent-1", checkoutRoot: "/work/p", legacy: true };
    fs.writeFileSync(file, JSON.stringify({ "321": { target, savedAt: Date.now() } }));
    const launch = vi.fn();
    try {
      const reply = await agentSession(
        undefined,
        (a) => {
          launch.mockResolvedValue({
            page: {
              url: () => "about:blank",
              title: async () => "t",
              content: async () => "<html></html>",
              evaluate: async () => null,
              locator: () => ({ ariaSnapshot: async () => "- body", all: async () => [] }),
            },
            consoleLogs: [],
            pageErrors: [],
          });
          vi.spyOn(a.browser, "getOrLaunch").mockImplementation(
            launch as unknown as typeof a.browser.getOrLaunch,
          );
        },
        { remember: false },
      );
      expect(reply.error).toBeUndefined();
      expect(launch).toHaveBeenCalledWith(target);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });

  it("refuses a session whose primary sent no browser target", async () => {
    const reply = await agentSession(undefined);
    expect(reply.error).toMatch(/no browser target/);
  });
});

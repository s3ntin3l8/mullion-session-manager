import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";
import { startFixturePageServer, type FixturePageServer } from "./support/fixture-page-server.js";

// Issue #407's checklist item "Multi-host: ... confirm ... browser navigate
// ... work[s] through RemoteHostClient proxying. The plan calls this 'the
// main thing the dispatch choice buys' — verify explicitly." — never
// exercised anywhere: test/integration/multi-host.test.ts (unit/integration,
// mocked pty) covers session spawn/attach/kill proxying but no browser.*
// path, and test/routes/browser-automation.test.ts covers the browser
// routes but never the remote-host branch. This file is the one place both
// meet, with a REAL (unmocked) Playwright browser on the agent side — the
// thing actually under test here is the proxy hop itself (primary's
// POST /api/sessions/:id/browser -> RemoteHostClient -> agent's
// POST /internal/sessions/:id/browser), so a real browser proves the whole
// round trip rather than just that a mock was reachable.
//
// node-pty/child_process are still faked (same combined shape as
// test/integration/multi-host.test.ts) since this file's session row is
// inserted directly (no real spawn needed for a browser-only check) but
// buildApp() itself still constructs a PtyManager regardless.
const fakePtyChildren: FakePty[] = [];

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
  spawn: vi.fn(() => {
    const child = new FakePty();
    fakePtyChildren.push(child);
    return child;
  }),
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return {
    ...actual,
    spawn: vi.fn((file: string, args: string[] = []) => {
      const ee = new EventEmitter() as EventEmitter & { stdout?: EventEmitter };
      if (file === "systemctl" && args[1] === "is-active") {
        ee.stdout = new EventEmitter();
        setImmediate(() => {
          ee.emit("exit", 0);
          setImmediate(() => {
            ee.stdout?.emit("data", Buffer.from("active\n"));
            ee.emit("close", 0);
          });
        });
        return ee;
      }
      if ((file === "systemctl" && args[1] === "stop") || file === "systemd-run") {
        setImmediate(() => ee.emit("exit", 0));
        return ee;
      }
      ee.stdout = new EventEmitter();
      setImmediate(() => ee.emit("close", 0));
      return ee;
    }),
  };
});

const { buildApp } = await import("../../src/app.js");
const { sessions } = await import("../../src/db/schema.js");

const AGENT_TOKEN = "e2e-multi-host-agent-token";
const primaryDb = path.join(
  os.tmpdir(),
  `multi-host-e2e-primary-${process.pid}-${crypto.randomBytes(4).toString("hex")}.db`,
);
const agentBrowserDataDir = path.join(
  os.tmpdir(),
  `multi-host-e2e-browser-data-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);
// test/setup.ts sets SESSIONS_DIR once per test FILE (module-level), and
// hooksPlugin registers unconditionally for both the "agent" and "primary"
// role branches (src/app.ts), binding `<SESSIONS_DIR>/hooks.sock`. This file
// is the only e2e test that builds two real, listening buildApp() instances
// in the same process — without giving each its own SESSIONS_DIR, the
// second `buildAndListen()` call below fails with
// SocketAlreadyListeningError the moment it tries to bind the same
// hooks.sock the first instance already owns. In real deployments this
// never happens (primary and agent are separate hosts with independent
// config), so this collision is purely an artifact of two in-process
// instances sharing one inherited env var — give each its own dir, same
// pattern as primaryDb/agentBrowserDataDir above.
const primarySessionsDir = path.join(
  os.tmpdir(),
  `multi-host-e2e-primary-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);
const agentSessionsDir = path.join(
  os.tmpdir(),
  `multi-host-e2e-agent-sessions-${process.pid}-${crypto.randomBytes(4).toString("hex")}`,
);

async function buildAndListen(env: Record<string, string>) {
  const prev: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    prev[key] = process.env[key];
    process.env[key] = env[key];
  }
  const app = await buildApp();
  for (const key of Object.keys(env)) {
    if (prev[key] === undefined) delete process.env[key];
    else process.env[key] = prev[key];
  }
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a real bound address");
  }
  return { app, port: address.port };
}

describe("multi-host proxy — browser automation (issue #407)", () => {
  let agent: Awaited<ReturnType<typeof buildAndListen>>;
  let primary: Awaited<ReturnType<typeof buildAndListen>>;
  let fixture: FixturePageServer;
  let hostId: string;
  let projectId: number;
  let sessionId: number;

  beforeAll(async () => {
    fs.rmSync(primaryDb, { force: true });
    fixture = await startFixturePageServer();

    agent = await buildAndListen({
      MULLION_ROLE: "agent",
      MULLION_AGENT_TOKEN: AGENT_TOKEN,
      PROJECTS_ROOTS: os.tmpdir(),
      BROWSER_ENABLED: "true",
      BROWSER_DATA_DIR: agentBrowserDataDir,
      SESSIONS_DIR: agentSessionsDir,
    });
    primary = await buildAndListen({
      DATABASE_URL: `file:${primaryDb}`,
      SESSIONS_DIR: primarySessionsDir,
    });

    const hostRes = await primary.app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: {
        name: "e2e-agent",
        baseUrl: `http://127.0.0.1:${agent.port}`,
        token: AGENT_TOKEN,
      },
    });
    hostId = hostRes.json().id;

    const projectRes = await primary.app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "remote-browser-e2e", cwd: "/tmp/remote-project", hostId },
    });
    projectId = projectRes.json().id;

    // Inserted directly (not POST /api/sessions) — a browser-automation
    // proxy check needs a session ROW to resolve project.hostId from, not a
    // real live pty (see resolveSessionPage/browser-automation.ts: it never
    // touches PtyManager at all).
    const [row] = primary.app.db
      .insert(sessions)
      .values({ projectId, command: "bash" })
      .returning()
      .all();
    sessionId = row.id;
  });

  afterAll(async () => {
    await primary.app.close();
    await agent.app.close();
    await fixture.close();
    fs.rmSync(primaryDb, { force: true });
    fs.rmSync(agentBrowserDataDir, { recursive: true, force: true });
    fs.rmSync(primarySessionsDir, { recursive: true, force: true });
    fs.rmSync(agentSessionsDir, { recursive: true, force: true });
  });

  it("proxies browser.action navigate through RemoteHostClient to the agent's real Chromium", async () => {
    const res = await primary.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser`,
      payload: { action: "navigate", url: fixture.url },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.url).toBe(fixture.url);
    expect(body.title).toBe("Fixture Page");

    // Confirm this actually reached the agent's own pooled browser instance
    // (not e.g. a coincidentally-matching local one) — the agent's
    // BrowserManager should now have exactly one live instance for this
    // project.
    expect(agent.app.browser.get(projectId)).toBeDefined();
  });

  it("proxies browser.find the same way", async () => {
    const res = await primary.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser/find`,
      payload: { by: "text", value: "Fixture Heading" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.matchCount).toBeGreaterThan(0);
  });

  it("proxies a frame-scoped browser.find through RemoteHostClient to the agent's internal route (issue #382, code review PR #429)", async () => {
    // Regression test for a call site the frame-field refactor missed:
    // /internal/sessions/:id/browser/find (the route RemoteHostClient posts
    // to for a remote-hosted project's find) still passed the bare `page`
    // instead of resolving `frame` first, so a frame-scoped find silently
    // searched the top-level document on the agent side. Real Chromium, real
    // separate-document iframe (`#frame-host` -> `/frame`), so this proves
    // the fix landed on the agent's own internal route, not just the
    // primary's own local dispatch (already covered by
    // browser-actions.e2e.test.ts).
    const res = await primary.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser/find`,
      payload: { by: "text", value: "Fixture Frame Heading", frame: "#frame-host" },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.matchCount).toBeGreaterThan(0);

    // The negative case: searching the top-level document (no `frame`) for
    // frame-only text must NOT find it — confirms the frame-scoped search
    // above actually reached the iframe's separate document rather than the
    // main one coincidentally containing the same text.
    const mainDocRes = await primary.app.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/browser/find`,
      payload: { by: "text", value: "Fixture Frame Heading" },
    });
    expect(mainDocRes.statusCode).toBe(200);
    expect(mainDocRes.json().matchCount).toBe(0);
  });
});

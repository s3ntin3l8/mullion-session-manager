import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { identityStatePath, loadAgentIdentity } from "../../src/services/agent-identity.js";

// Issue #2452 — headless enrollment end to end: a REAL primary behind a fetch
// adapter, an agent that advertises no URL, and repeated agent daemon restarts.
// The agent is stateless apart from agent-identity.json in SESSIONS_DIR, so
// every restart (and a "re-image" that lost the file) is exercised for what it
// does to the primary's host table.
const tmpDb = path.join(os.tmpdir(), `agent-restart-reenroll-${process.pid}.db`);

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

const AGENT_ENV = [
  "MULLION_ROLE",
  "MULLION_PRIMARY_URL",
  "MULLION_ENROLLMENT_TOKEN",
  "MULLION_AGENT_ADVERTISE_URL",
  "PROJECTS_ROOTS",
  "SESSIONS_DIR",
  "MULLION_ENROLLMENT_SECRET",
];

describe("agent restart and re-enrollment (issue #2452)", () => {
  let primary: FastifyInstance;
  let sessionsDir: string;
  let statePath: string;
  let registerBodies: Array<Record<string, unknown>>;
  const agents: FastifyInstance[] = [];

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret"; // pragma: allowlist secret
    primary = await buildApp();
  });
  afterAll(async () => {
    await primary.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    for (const k of AGENT_ENV) delete process.env[k];
  });

  function stubPrimaryFetch() {
    registerBodies = [];
    vi.stubGlobal("fetch", async (url: string | URL, init?: RequestInit) => {
      const target = new URL(String(url));
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (target.pathname === "/api/internal/register") registerBodies.push(body);
      const res = await primary.inject({
        method: (init?.method ?? "GET") as "GET" | "POST",
        url: target.pathname,
        payload: init?.body ? body : undefined,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: { "content-type": "application/json" },
      });
    });
  }

  function newSessionsDir() {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-restart-sessions-"));
    statePath = identityStatePath(sessionsDir);
  }

  // Boot the agent daemon the way the installed .env does: no advertised URL.
  async function bootAgent(enrollmentToken = "fleet-secret") {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    process.env.MULLION_ENROLLMENT_TOKEN = enrollmentToken;
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
    delete process.env.MULLION_ENROLLMENT_SECRET;
    const agent = await buildApp();
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret"; // pragma: allowlist secret
    agents.push(agent);
    await agent.ready();
    return agent;
  }

  const enrolledRows = () =>
    primary.db
      .select()
      .from(hosts)
      .all()
      .filter((h) => h.origin === "enrolled");

  afterEach(async () => {
    while (agents.length) await agents.pop()!.close();
    vi.unstubAllGlobals();
    if (sessionsDir) fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("enrolls once, then every restart and upgrade reuses the same host row by identity", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    const before = enrolledRows().length;

    await bootAgent();
    await waitUntil(() => loadAgentIdentity(statePath) !== null);
    const first = loadAgentIdentity(statePath)!;
    expect(registerBodies[0]).toMatchObject({
      token: "fleet-secret",
      wantsMachineCredential: true,
    });
    expect(registerBodies[0].baseUrl).toBeUndefined();
    expect(enrolledRows()).toHaveLength(before + 1);

    let previous = first;
    for (let restart = 0; restart < 3; restart++) {
      await agents.pop()!.close();
      registerBodies.length = 0;
      // The rerun's environment carries a ROTATED enrollment token: an
      // enrolled agent must keep using its identity, never the bootstrap token.
      await bootAgent(restart === 2 ? "rotated-fleet-secret" : "fleet-secret"); // pragma: allowlist secret
      await waitUntil(
        () => loadAgentIdentity(statePath)?.machineCredential !== previous.machineCredential,
      );
      const now = loadAgentIdentity(statePath)!;
      expect(now.hostId).toBe(first.hostId);
      expect(now.machineCredential).not.toBe(previous.machineCredential);
      expect(registerBodies[0]).toMatchObject({
        hostId: first.hostId,
        machineCredential: previous.machineCredential,
      });
      expect(registerBodies[0].token).toBeUndefined();
      previous = now;
    }
    expect(enrolledRows()).toHaveLength(before + 1);
    expect(enrolledRows().find((h) => h.id === first.hostId)?.baseUrl ?? null).toBeNull();
  });

  it("stays out of the primary's table after an operator revoke, and does not fall back to the bootstrap token", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    await bootAgent();
    await waitUntil(() => loadAgentIdentity(statePath) !== null);
    const identity = loadAgentIdentity(statePath)!;
    const rows = enrolledRows().length;

    expect(
      (await primary.inject({ method: "POST", url: `/api/hosts/${identity.hostId}/revoke` }))
        .statusCode,
    ).toBe(204);

    await agents.pop()!.close();
    registerBodies.length = 0;
    const agent = await bootAgent();
    await waitUntil(() => registerBodies.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(registerBodies).toHaveLength(1);
    expect(registerBodies[0].token).toBeUndefined();
    expect(agent.agentSession).toBeUndefined();
    // The state file is the operator's to clear; the row count is unchanged.
    expect(loadAgentIdentity(statePath)).toEqual(identity);
    expect(enrolledRows()).toHaveLength(rows);
  });

  it("re-enrolls as a NEW host (never taking another identity) when the state file is lost", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    await bootAgent();
    await waitUntil(() => loadAgentIdentity(statePath) !== null);
    const lost = loadAgentIdentity(statePath)!;

    await agents.pop()!.close();
    fs.rmSync(statePath);
    await bootAgent();
    await waitUntil(() => loadAgentIdentity(statePath) !== null);
    const fresh = loadAgentIdentity(statePath)!;

    expect(fresh.hostId).not.toBe(lost.hostId);
    expect(fresh.machineCredential).not.toBe(lost.machineCredential);
    // The orphaned credential is still only good for its own row.
    const stale = await primary.inject({
      method: "POST",
      url: "/api/internal/register",
      payload: {
        hostId: fresh.hostId,
        machineCredential: lost.machineCredential,
        baseUrl: "http://10.3.0.1:4000",
        hostname: "box",
      },
    });
    expect(stale.statusCode).toBe(401);
  });
});

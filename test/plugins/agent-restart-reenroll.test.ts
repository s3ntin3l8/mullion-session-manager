import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { identityStatePath, loadAgentIdentity } from "../../src/services/agent-identity.js";
import { redeemPairingCode } from "../../src/services/agent-pairing-redeem.js";
import { setDotenvPathForTests } from "../../src/plugins/env.js";

// Issue #2452 — headless enrollment end to end: a REAL primary behind a fetch
// adapter and repeated agent daemon restarts. Issue #3577 removed the
// MULLION_ENROLLMENT_TOKEN bootstrap, so the identity now always comes from a
// one-time pairing code (redeemed through the same fetch adapter); booting
// without one is a fail-closed error, not a fresh enrollment.
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
  "MULLION_HOME",
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

  // The only enrollment path left (issue #3577): redeem a one-time pairing
  // code against the primary through the same fetch adapter.
  async function pair(label: string) {
    const res = await primary.inject({
      method: "POST",
      url: "/api/host-pairings",
      payload: { label },
    });
    expect(res.statusCode).toBe(200);
    return redeemPairingCode({
      primaryUrl: "http://primary.invalid",
      code: (res.json() as { code: string }).code,
      sessionsDir,
      name: label,
    });
  }

  // Boot the agent daemon the way the installed .env does: no advertised URL
  // and no token in the environment, only the paired identity.
  async function bootAgent() {
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
    const agent = await buildApp();
    agents.push(agent);
    await agent.ready();
    return agent;
  }

  const enrolledRows = () =>
    primary.db
      .select()
      .from(hosts)
      .all()
      .filter((h) => h.id !== "local");

  afterEach(async () => {
    while (agents.length) await agents.pop()!.close();
    vi.unstubAllGlobals();
    if (sessionsDir) fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("boots from a paired identity, renews it, and every restart reuses the same host row", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    const before = enrolledRows().length;
    await pair("restart-1");
    const paired = loadAgentIdentity(statePath)!;
    expect(enrolledRows()).toHaveLength(before + 1);

    await bootAgent();
    await waitUntil(
      () => loadAgentIdentity(statePath)?.machineCredential !== paired.machineCredential,
    );
    const first = loadAgentIdentity(statePath)!;
    expect(first.hostId).toBe(paired.hostId);
    expect(registerBodies[0]).toMatchObject({
      hostId: paired.hostId,
      machineCredential: paired.machineCredential,
    });
    expect(registerBodies[0].token).toBeUndefined();
    expect(registerBodies[0].baseUrl).toBeUndefined();

    let previous = first;
    for (let restart = 0; restart < 3; restart++) {
      await agents.pop()!.close();
      registerBodies.length = 0;
      await bootAgent();
      await waitUntil(
        () => loadAgentIdentity(statePath)?.machineCredential !== previous.machineCredential,
      );
      const now = loadAgentIdentity(statePath)!;
      expect(now.hostId).toBe(paired.hostId);
      expect(registerBodies[0]).toMatchObject({
        hostId: paired.hostId,
        machineCredential: previous.machineCredential,
      });
      expect(registerBodies[0].token).toBeUndefined();
      previous = now;
    }
    expect(enrolledRows()).toHaveLength(before + 1);
    expect(enrolledRows().find((h) => h.id === paired.hostId)?.baseUrl ?? null).toBeNull();
  });

  it("stays out of the primary's table after an operator revoke, with no fallback credential", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    const paired = await pair("restart-2");
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
    // The agent's own retry state, not a timing window: the rejection is
    // terminal, so it is not retrying (no failed attempt, no backoff pending).
    await waitUntil(() => agent.agentEnrollment?.state === "rejected");
    expect(agent.agentEnrollment?.failedAttempts).toBe(0);
    expect(registerBodies).toHaveLength(1);
    expect(registerBodies[0].token).toBeUndefined();
    expect(agent.agentSession).toBeUndefined();
    // The state file is the operator's to clear; the row count is unchanged.
    expect(loadAgentIdentity(statePath)).toEqual(identity);
    expect(enrolledRows()).toHaveLength(rows);
    expect(identity.hostId).toBe(paired.hostId);
  });

  it("refuses to boot with no identity, naming the pairing command and the doc section", async () => {
    newSessionsDir();
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;

    await expect(buildApp()).rejects.toThrow(/refusing to boot an agent/i);
    await expect(buildApp()).rejects.toThrow(/MULLION_AGENT_PAIRING_CODE_STDIN=1/);
    await expect(buildApp()).rejects.toThrow(/MULLION_AGENT_PAIRING_FORCE=1/);
    await expect(buildApp()).rejects.toThrow(/Automating agent deploys/);
  });

  it("refuses to boot when a lost identity file leaves nothing to register with", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    await pair("restart-3");
    await bootAgent();
    await waitUntil(() => loadAgentIdentity(statePath) !== null);
    await agents.pop()!.close();

    // A "re-image" that loses the file must not silently enroll as a new host:
    // there is no bootstrap token any more, so the agent fails closed.
    fs.rmSync(statePath);
    await expect(buildApp()).rejects.toThrow(/refusing to boot an agent/i);
    expect(loadAgentIdentity(statePath)).toBeNull();
  });

  // Issue #3577 — an old install's .env still carries the removed variable.
  // It must be ignored: the agent boots on its paired identity and never sends
  // the leftover value anywhere.
  it("ignores a leftover MULLION_ENROLLMENT_TOKEN in .env and still boots and renews", async () => {
    newSessionsDir();
    stubPrimaryFetch();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "agent-leftover-home-"));
    const leftover = "leftover-enrollment-token-4b9d"; // pragma: allowlist secret
    fs.writeFileSync(
      path.join(home, ".env"),
      `MULLION_PRIMARY_URL=http://primary.invalid\nMULLION_ENROLLMENT_TOKEN=${leftover}\n`,
      { mode: 0o600 },
    );
    await pair("leftover");
    const paired = loadAgentIdentity(statePath)!;

    process.env.MULLION_HOME = home;
    setDotenvPathForTests(path.join(home, ".env"));
    try {
      const agent = await bootAgent();
      await waitUntil(
        () => loadAgentIdentity(statePath)?.machineCredential !== paired.machineCredential,
      );
      expect(agent.config).not.toHaveProperty("MULLION_ENROLLMENT_TOKEN");
      expect(registerBodies.length).toBeGreaterThanOrEqual(1);
      expect(registerBodies[0]).toMatchObject({
        hostId: paired.hostId,
        machineCredential: paired.machineCredential,
      });
      expect(registerBodies[0].token).toBeUndefined();
      expect(JSON.stringify(registerBodies)).not.toContain(leftover);
    } finally {
      setDotenvPathForTests(null);
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

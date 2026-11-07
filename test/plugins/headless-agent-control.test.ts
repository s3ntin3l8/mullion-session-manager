import { describe, it, expect, beforeAll, afterAll } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts } from "../../src/db/schema.js";
import { identityStatePath, loadAgentIdentity } from "../../src/services/agent-identity.js";
import { resolveBackend } from "../../src/services/session-backend.js";

// Issue #2691 — ongoing operations of a HEADLESS enrolled agent. The #2452
// registrations send no baseUrl so the relay never dials the agent; this proves
// the other half: the agent dials the primary's channel and a control call made
// on the primary still completes. A real listening primary, a real agent app,
// real fetch and WebSocket — nothing in between is stubbed.
const tmpDb = path.join(os.tmpdir(), `headless-agent-control-${process.pid}.db`);

async function waitUntil(check: () => boolean, timeoutMs = 10_000): Promise<void> {
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
  "PROJECTS_ROOTS",
  "SESSIONS_DIR",
  "MULLION_ENROLLMENT_SECRET",
];

describe("headless enrolled agent: ongoing control operations (issue #2691)", () => {
  let primary: FastifyInstance;
  let agent: FastifyInstance;
  let sessionsDir: string;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_ENROLLMENT_SECRET = "fleet-secret"; // pragma: allowlist secret
    primary = await buildApp();
    await primary.listen({ port: 0, host: "127.0.0.1" });
    const port = (primary.server.address() as { port: number }).port;

    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "headless-agent-sessions-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = `http://127.0.0.1:${port}`;
    process.env.MULLION_ENROLLMENT_TOKEN = "fleet-secret"; // pragma: allowlist secret
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
    delete process.env.MULLION_ENROLLMENT_SECRET;
    agent = await buildApp();
    await agent.ready();
  });

  afterAll(async () => {
    await agent.close();
    await primary.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.DATABASE_URL;
    for (const k of AGENT_ENV) delete process.env[k];
  });

  it("enrolls without an address, connects its channel, and a control call completes through the primary", async () => {
    await waitUntil(() => loadAgentIdentity(identityStatePath(sessionsDir)) !== null);
    const { hostId } = loadAgentIdentity(identityStatePath(sessionsDir))!;
    await waitUntil(() => agent.agentChannelStatus.state === "ready");

    const row = primary.db
      .select()
      .from(hosts)
      .all()
      .find((h) => h.id === hostId)!;
    expect(row.baseUrl).toBeNull();

    const backend = resolveBackend(primary, hostId);
    // A read and a mutation, both carried by the channel (there is no URL to dial).
    const liveness = await backend.liveness(["4242"]);
    expect(liveness["4242"]).toBeDefined();
    await expect(backend.stashSeed("4242", "seed over the channel")).resolves.toBeUndefined();
  });
});

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import type * as ChildProcess from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { FastifyInstance } from "fastify";

// Issue #2703 — the agent's session spawn runs through fakes for node-pty and
// the systemd/dtach child processes (a test must never let a real systemd-run
// fire, #1137); the primary-to-agent hop itself — HTTP, WebSocket, the channel
// — stays real.
const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { hosts } = await import("../../src/db/schema.js");
const { identityStatePath, loadAgentIdentity } =
  await import("../../src/services/agent-identity.js");
const { resolveBackend } = await import("../../src/services/session-backend.js");

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

  it("does real work over the channel: spawns a session, the agent records the seed, and terminates it (#2703)", async () => {
    await waitUntil(() => loadAgentIdentity(identityStatePath(sessionsDir)) !== null);
    const { hostId } = loadAgentIdentity(identityStatePath(sessionsDir))!;
    await waitUntil(() => agent.agentChannelStatus.state === "ready");
    const backend = resolveBackend(primary, hostId);
    const id = "99901";

    // The seed is stashed on the AGENT before the session starts (promote's order).
    await backend.stashSeed(id, "seed recorded by the agent");
    const spawned = await backend.spawn({
      id,
      cwd: os.tmpdir(),
      command: "sleep 60",
      cols: 80,
      rows: 24,
    });
    expect(spawned).toBeDefined();

    // The agent really holds the session, and really recorded the seed:
    // consumeSeed is the agent's own read of what stashSeed wrote.
    expect(agent.pty.get(id)).toBeDefined();
    expect(agent.pty.consumeSeed(id)).toBe("seed recorded by the agent");

    await expect(backend.terminate(id)).resolves.toBeUndefined();
    expect(agent.pty.get(id)).toBeUndefined();
    expect(agent.pty.consumeSeed(id)).toBeNull();
  });
});

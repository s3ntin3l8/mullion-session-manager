import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";

// Issue #245 / roadmap 7.1 — the agent-side half of self-registration.
// Exercises agentEnrollmentPlugin's real onReady/timer wiring with a
// stubbed fetch instead of a live primary — cheap and precise for the
// retry/backoff and renewal-401-fallback paths that
// test/integration/multi-host.test.ts's two-real-buildApp() harness can't
// easily inject (Hermes review, PR #528).

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition never became true");
}

describe("agentEnrollmentPlugin", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let sessionsDir: string;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-enrollment-sessions-"));
    process.env.MULLION_ROLE = "agent";
    process.env.MULLION_PRIMARY_URL = "http://primary.invalid";
    process.env.MULLION_ENROLLMENT_TOKEN = "bootstrap-secret";
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.SESSIONS_DIR;
  });

  it("registers on boot via the real onReady hook and sets app.agentSession", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-1",
        session_id: "sess-1",
        session_secret: "secret-1", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      expect(app.agentSession).toMatchObject({ hostId: "host-1", sessionId: "sess-1" });

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string);
      expect(body.token).toBe("bootstrap-secret");
      expect(body.hostId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("retries with backoff when the primary is unreachable, then succeeds", async () => {
    fetchMock.mockRejectedValueOnce(new Error("connect ECONNREFUSED")).mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-2",
        session_id: "sess-2",
        session_secret: "secret-2", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );

    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined, 10_000);
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(app.agentSession).toMatchObject({ hostId: "host-2" });
    } finally {
      await app.close();
    }
  });

  it("falls back to the bootstrap token when a renewal is rejected, not just retrying the stale session", async () => {
    fetchMock
      // Initial registration — short TTL so renewal fires almost
      // immediately (renewal is scheduled at max(ttl/2, 1s)).
      .mockResolvedValueOnce(
        jsonResponse(200, {
          host_id: "host-3",
          session_id: "sess-3-initial",
          session_secret: "secret-3", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 2_000).toISOString(),
        }),
      )
      // Renewal attempt — the primary rejects it (e.g. session expired on
      // its side too, or the DB was lost).
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      // Bootstrap re-registration fallback — must succeed.
      .mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-3",
          session_id: "sess-3-refreshed",
          session_secret: "secret-3b", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession?.sessionId === "sess-3-initial");
      await waitUntil(() => app.agentSession?.sessionId === "sess-3-refreshed", 10_000);

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      const renewalCallBody = JSON.parse(
        (fetchMock.mock.calls[1][1] as RequestInit).body as string,
      );
      expect(renewalCallBody.token).toBe("sess-3-initial");
      const fallbackCallBody = JSON.parse(
        (fetchMock.mock.calls[2][1] as RequestInit).body as string,
      );
      // The fallback re-registers with the bootstrap credential, never the
      // now-rejected session id — that's the whole point of the fallback.
      expect(fallbackCallBody.token).toBe("bootstrap-secret");
      expect(fallbackCallBody.hostId).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("is a no-op for an agent with only a static MULLION_AGENT_TOKEN configured (today's flow, unchanged)", async () => {
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
    process.env.MULLION_AGENT_TOKEN = "static-token";

    const app = await buildApp();
    try {
      await app.ready();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fetchMock).not.toHaveBeenCalled();
      expect(app.agentSession).toBeUndefined();
    } finally {
      delete process.env.MULLION_AGENT_TOKEN;
      await app.close();
    }
  });

  // Independent review, PR #528: a registration call in flight when
  // app.close() runs must not resurrect app.agentSession (or arm a new
  // renewal timer) once it eventually resolves — onClose already declared
  // this agent stopped.
  it("does not resurrect app.agentSession if onClose fires while a registration call is still in flight", async () => {
    let resolveFetch!: (res: Response) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const app = await buildApp();
    await app.ready();
    await waitUntil(() => fetchMock.mock.calls.length >= 1);

    await app.close();
    expect(app.agentSession).toBeUndefined();

    resolveFetch(
      jsonResponse(200, {
        host_id: "host-4",
        session_id: "sess-4",
        session_secret: "secret-4", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(app.agentSession).toBeUndefined();
  });
});

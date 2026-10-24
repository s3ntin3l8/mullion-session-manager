import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as SuspendDetectModule from "../../src/services/suspend-detect.js";
import { buildApp } from "../../src/app.js";

// Issue #245 / roadmap 7.1 — the agent-side half of self-registration.
// Exercises agentEnrollmentPlugin's real onReady/timer wiring with a
// stubbed fetch instead of a live primary — cheap and precise for the
// retry/backoff and renewal-401-fallback paths that
// test/integration/multi-host.test.ts's two-real-buildApp() harness can't
// easily inject (Hermes review, PR #528).
//
// Issue #1719 (roadmap 8.5) — the resume path is exercised here too. The
// suspend watcher itself is MOCKED (not the detection, which
// test/services/suspend-detect.test.ts covers): what matters here is that
// the agent's resume handler runs, so the test drives the listeners directly
// rather than waiting out a wall-clock gap.
const { resumeListeners } = vi.hoisted(() => ({
  resumeListeners: [] as ((event: { sleptMs: number }) => void)[],
}));

vi.mock("../../src/services/suspend-detect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof SuspendDetectModule>();
  return {
    ...actual,
    startSuspendWatcher: () => ({
      onResume(listener: (event: { sleptMs: number }) => void) {
        resumeListeners.push(listener);
        return () => {
          const index = resumeListeners.indexOf(listener);
          if (index >= 0) resumeListeners.splice(index, 1);
        };
      },
      stop: () => {},
    }),
  };
});

/** Simulates a resume: every registered listener is told the host is back. */
function fireResume(sleptMs = 8 * 60 * 60 * 1000): void {
  for (const listener of [...resumeListeners]) listener({ sleptMs });
}

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
    resumeListeners.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_PRIMARY_URL;
    delete process.env.MULLION_ENROLLMENT_TOKEN;
    delete process.env.PROJECTS_ROOTS;
    delete process.env.SESSIONS_DIR;
    delete process.env.MULLION_HOME;
    delete process.env.MULLION_AGENT_TOKEN;
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

  // Issue #1719 (roadmap 8.5) — sleep/wake credential recovery.
  describe("sleep/wake credential recovery", () => {
    let mullionHome: string;

    beforeEach(() => {
      mullionHome = fs.mkdtempSync(path.join(os.tmpdir(), "agent-enrollment-home-"));
      process.env.MULLION_HOME = mullionHome;
    });

    afterEach(() => {
      fs.rmSync(mullionHome, { recursive: true, force: true });
    });

    // The bullet #1719 was written for: an agent whose credential was
    // rotated while it slept must re-establish a valid credential instead of
    // failing permanently. Before #1719 the bootstrap token was read from the
    // env file ONCE, at boot, so a rotated value was retried forever and the
    // agent was stranded until someone restarted it.
    it("re-reads the env file and retries with a ROTATED bootstrap credential after a 401", async () => {
      // The operator rotated the secret on the primary and updated the
      // agent's own .env — the file the launchd launcher sources.
      fs.writeFileSync(
        path.join(mullionHome, ".env"),
        "MULLION_ENROLLMENT_TOKEN=rotated-secret\n",
        "utf8",
      );

      fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 })).mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-rotated",
          session_id: "sess-rotated",
          session_secret: "secret-rotated", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      try {
        await app.ready();
        await waitUntil(() => app.agentSession !== undefined, 10_000);

        expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2);
        const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
        // The first attempt used the credential this process booted with…
        expect(firstBody.token).toBe("bootstrap-secret");
        // …and the retry used the ROTATED one, picked up from the env file —
        // with no restart of the agent.
        expect(secondBody.token).toBe("rotated-secret");
      } finally {
        await app.close();
      }
    });

    it("keeps retrying the SAME credential when the env file has not changed", async () => {
      fs.writeFileSync(
        path.join(mullionHome, ".env"),
        "MULLION_ENROLLMENT_TOKEN=bootstrap-secret\n",
        "utf8",
      );

      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      const app = await buildApp();
      try {
        await app.ready();
        await waitUntil(() => fetchMock.mock.calls.length >= 2, 10_000);

        const firstBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        const secondBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
        expect(firstBody.token).toBe("bootstrap-secret");
        expect(secondBody.token).toBe("bootstrap-secret");
      } finally {
        await app.close();
      }
    });

    it("revalidates the credential immediately on resume, rather than waiting for the renewal tick", async () => {
      // A FRESH Response per call: a Response's body can only be read once,
      // so a shared instance would make the second (resume) call fail on the
      // body rather than on anything this test is about.
      fetchMock.mockImplementation(() =>
        jsonResponse(200, {
          host_id: "host-resume",
          session_id: "sess-resume",
          session_secret: "secret-resume", // pragma: allowlist secret
          // A LONG TTL: the renewal timer is half an hour away, so anything
          // that revalidates promptly did so because of the resume, not
          // because the renewal happened to be due.
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
      );

      const app = await buildApp();
      try {
        await app.ready();
        await waitUntil(() => app.agentSession !== undefined);
        fetchMock.mockClear();

        fireResume();

        await waitUntil(() => fetchMock.mock.calls.length >= 1, 5000);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        // The revalidation renews the EXISTING session (its id), not a fresh
        // bootstrap registration.
        expect(body.token).toBe("sess-resume");
        expect(body.hostId).toBe("host-resume");
      } finally {
        await app.close();
      }
    });

    it("refreshes a ROTATED static MULLION_AGENT_TOKEN on resume, so the inbound gate accepts the primary again", async () => {
      // A manual-token-only agent: it never calls out to the primary, so it
      // has no session to renew — but the primary presents ITS token to this
      // agent, and the inbound gate (routes/internal.ts) compares it against
      // app.config. A rotated token would leave the agent unable to serve
      // the primary until it restarted.
      delete process.env.MULLION_PRIMARY_URL;
      delete process.env.MULLION_ENROLLMENT_TOKEN;
      process.env.MULLION_AGENT_TOKEN = "static-token-1";
      fs.writeFileSync(
        path.join(mullionHome, ".env"),
        "MULLION_AGENT_TOKEN=static-token-2\n",
        "utf8",
      );

      const app = await buildApp();
      try {
        await app.ready();
        expect(app.config.MULLION_AGENT_TOKEN).toBe("static-token-1");

        fireResume();

        await waitUntil(() => app.config.MULLION_AGENT_TOKEN === "static-token-2", 5000);
        expect(app.config.MULLION_AGENT_TOKEN).toBe("static-token-2");
        // A static-token agent never calls out — the refresh is entirely
        // local.
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        await app.close();
      }
    });

    it("does nothing on a resume once the agent is shutting down", async () => {
      fetchMock.mockImplementation(() =>
        jsonResponse(200, {
          host_id: "host-stopped",
          session_id: "sess-stopped",
          session_secret: "secret-stopped", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);

      await app.close();
      // Cleared AFTER the close: the close itself makes the best-effort
      // deregister call, which is not what this test is about.
      fetchMock.mockClear();

      fireResume();

      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // Issue #248 / roadmap 7.3 — graceful deregistration.
  describe("onClose deregistration", () => {
    it("calls POST /api/internal/deregister with the current session's hostId+sessionId on shutdown", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-5",
          session_id: "sess-5",
          session_secret: "secret-5", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

      await app.close();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("http://primary.invalid/api/internal/deregister");
      const body = JSON.parse(init.body as string);
      expect(body).toEqual({ hostId: "host-5", sessionId: "sess-5" });
    });

    it("does not call deregister if the agent never successfully registered", async () => {
      fetchMock.mockReturnValue(new Promise(() => {})); // never resolves

      const app = await buildApp();
      await app.ready();
      await waitUntil(() => fetchMock.mock.calls.length >= 1);
      fetchMock.mockClear();

      await app.close();

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("does not throw or hang shutdown when the primary is unreachable for the deregister call", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-6",
          session_id: "sess-6",
          session_secret: "secret-6", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      fetchMock.mockClear();
      fetchMock.mockRejectedValue(new Error("connect ECONNREFUSED"));

      await expect(app.close()).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("does not throw when the primary rejects the deregister call (non-2xx)", async () => {
      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-7",
          session_id: "sess-7",
          session_secret: "secret-7", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      fetchMock.mockClear();
      fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

      await expect(app.close()).resolves.toBeUndefined();
    });
  });
});

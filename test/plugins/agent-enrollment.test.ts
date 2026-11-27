import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as SuspendDetectModule from "../../src/services/suspend-detect.js";
import { buildApp } from "../../src/app.js";
import { identityStatePath } from "../../src/services/agent-identity.js";

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
    process.env.PROJECTS_ROOTS = os.tmpdir();
    process.env.SESSIONS_DIR = sessionsDir;
    // A paired agent: src/app.ts refuses to boot an enrolling agent without
    // this file (issue #3577).
    fs.writeFileSync(
      identityStatePath(sessionsDir),
      JSON.stringify({ hostId: "host-1", machineCredential: "a1".repeat(32) }),
    );
    resumeListeners.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fs.rmSync(sessionsDir, { recursive: true, force: true });
    delete process.env.MULLION_ROLE;
    delete process.env.MULLION_PRIMARY_URL;
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
      expect(body).toMatchObject({
        hostId: "host-1",
        machineCredential: "a1".repeat(32),
      });
      expect(body.token).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("advertises no URL when it only listens on loopback and none is configured (#2572)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-n",
        session_id: "sess-n",
        session_secret: "secret-n", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body).not.toHaveProperty("baseUrl");
      expect(body.wantsMachineCredential).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("keeps the hostname:PORT guess for an agent told to listen on a routable address (#2572)", async () => {
    process.env.HOST = "0.0.0.0";
    process.env.PORT = "4123";
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-l",
        session_id: "sess-l",
        session_secret: "secret-l", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.baseUrl).toBe(`http://${os.hostname()}:4123`);
    } finally {
      await app.close();
      delete process.env.HOST;
      delete process.env.PORT;
    }
  });

  it("sends an explicit advertise URL unchanged (#2572)", async () => {
    process.env.MULLION_AGENT_ADVERTISE_URL = "http://agent.example:4000";
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-e",
        session_id: "sess-e",
        session_secret: "secret-e", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string);
      expect(body.baseUrl).toBe("http://agent.example:4000");
    } finally {
      await app.close();
      delete process.env.MULLION_AGENT_ADVERTISE_URL;
    }
  });

  it("falls back to the old address guess once against a primary that requires a baseUrl (#2572)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { message: "body must have baseUrl" }));
    fetchMock.mockResolvedValue(
      jsonResponse(200, {
        host_id: "host-f",
        session_id: "sess-f",
        session_secret: "secret-f", // pragma: allowlist secret
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }),
    );
    const app = await buildApp();
    try {
      await app.ready();
      await waitUntil(() => app.agentSession !== undefined);
      const second = JSON.parse(
        (fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string,
      );
      expect(second.baseUrl).toMatch(/^http:\/\/.+:\d+$/);
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

  // Issue #3502 — a 3xx from /api/internal/register means a login gateway sits
  // in front of the primary; diagnose once per process and keep retrying.
  it("explains a 302 redirect from a login gateway once without leaking Location or token and keeps retrying", async () => {
    const location = "https://login.example.com/?token=super-secret";
    fetchMock.mockImplementation(
      async () => new Response(null, { status: 302, headers: { location } }),
    );

    const app = await buildApp();
    const warnSpy = vi.spyOn(app.log, "warn");
    try {
      await app.ready();
      await waitUntil(() => fetchMock.mock.calls.length >= 2, 10_000);

      expect(app.agentEnrollment?.state).toBe("registering");
      expect(app.agentEnrollment?.failedAttempts).toBeGreaterThanOrEqual(1);

      const warnMessages = warnSpy.mock.calls.map((args) =>
        args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "),
      );
      const diagnosisLogs = warnMessages.filter((msg) => msg.includes("redirect"));
      expect(diagnosisLogs).toHaveLength(1);

      const diagnosis = diagnosisLogs[0]!;
      expect(diagnosis).toMatch(/redirect/i);
      expect(diagnosis).toContain("302");
      expect(diagnosis).toContain("MULLION_AGENT_PRIMARY_URL");
      expect(diagnosis).toContain("MULLION_PRIMARY_URL");
      expect(diagnosis).toMatch(/restart/i);
      expect(diagnosis).not.toBe("registration request failed: HTTP 302");

      const allWarnings = warnMessages.join("\n");
      expect(allWarnings).not.toContain("login.example.com");
      expect(allWarnings).not.toContain("super-secret");
      expect(allWarnings).not.toContain("a1".repeat(32));
    } finally {
      await app.close();
    }
  });

  it("falls back to identity re-registration when a renewal fails transiently", async () => {
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
      // Renewal attempt — a transient failure (the primary restarting).
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      // Identity re-registration fallback — must succeed.
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
      expect(renewalCallBody).toMatchObject({
        hostId: "host-1",
        machineCredential: "a1".repeat(32),
      });
      const fallbackCallBody = JSON.parse(
        (fetchMock.mock.calls[2][1] as RequestInit).body as string,
      );
      // The fallback re-registers with the same stored identity.
      expect(fallbackCallBody).toMatchObject({
        hostId: "host-1",
        machineCredential: "a1".repeat(32),
      });
      expect(fallbackCallBody.token).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("is a no-op for an agent with only a static MULLION_AGENT_TOKEN configured (today's flow, unchanged)", async () => {
    delete process.env.MULLION_PRIMARY_URL;
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

    // Issue #3577: the enrolling agent's credential is
    // agent-identity.json, which rotates through the primary's renewal
    // response — there is no bootstrap token in the env file to re-read.
    it("never reads a leftover MULLION_ENROLLMENT_TOKEN from the env file", async () => {
      fs.writeFileSync(
        path.join(mullionHome, ".env"),
        "MULLION_ENROLLMENT_TOKEN=leftover-secret\n", // pragma: allowlist secret
        "utf8",
      );

      fetchMock.mockResolvedValue(
        jsonResponse(200, {
          host_id: "host-1",
          session_id: "sess-leftover",
          session_secret: "secret-leftover", // pragma: allowlist secret
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
      );

      const app = await buildApp();
      try {
        await app.ready();
        await waitUntil(() => app.agentSession !== undefined);
        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body).toMatchObject({
          hostId: "host-1",
          machineCredential: "a1".repeat(32),
        });
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("leftover-secret");
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
        // The revalidation renews by the stored identity, not by waiting for
        // the renewal tick.
        expect(body).toMatchObject({
          hostId: "host-1",
          machineCredential: "a1".repeat(32),
        });
        expect(body.token).toBeUndefined();
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
      process.env.MULLION_AGENT_TOKEN = "static-token-1";
      fs.writeFileSync(
        path.join(mullionHome, ".env"),
        "MULLION_AGENT_TOKEN=static-token-2\n", // pragma: allowlist secret
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

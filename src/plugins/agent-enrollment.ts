import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import os from "node:os";

// Issue #245 / roadmap 7.1 — the agent-side half of agent-initiated
// registration. Agent-role-only, and inert unless both MULLION_PRIMARY_URL
// and MULLION_ENROLLMENT_TOKEN are set (a manual-token-only agent — today's
// flow, unchanged — never calls out anywhere). The agent stays DB-less
// throughout: everything here is in-memory, re-established from the env
// file on every boot via the bootstrap token, exactly what a
// config-management-driven deploy (Ansible, ...) wants.
export interface AgentSession {
  hostId: string;
  sessionId: string;
  sessionSecret: string;
  expiresAt: Date;
}

interface RegisterResponse {
  host_id: string;
  session_id: string;
  session_secret: string;
  expires_at: string;
}

// Capped exponential-ish backoff for the initial registration loop — an
// agent must not fail to boot just because the primary is briefly
// unreachable (a rolling deploy, the primary restarting mid-way through
// this agent's own boot). Repeats at the last (30s) delay indefinitely.
const REGISTER_RETRY_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
const REGISTER_TIMEOUT_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

function resolveAdvertiseUrl(app: FastifyInstance): string {
  if (app.config.MULLION_AGENT_ADVERTISE_URL) return app.config.MULLION_AGENT_ADVERTISE_URL;
  return `http://${os.hostname()}:${app.config.PORT}`;
}

async function callRegister(
  app: FastifyInstance,
  opts: { token: string; hostId?: string },
): Promise<AgentSession> {
  const body = {
    token: opts.token,
    hostId: opts.hostId,
    baseUrl: resolveAdvertiseUrl(app),
    hostname: os.hostname(),
    name: app.config.MULLION_AGENT_NAME || undefined,
  };
  const res = await fetch(
    `${app.config.MULLION_PRIMARY_URL.replace(/\/+$/, "")}/api/internal/register`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
      redirect: "manual",
    },
  );
  if (!res.ok) {
    throw new Error(`registration request failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as RegisterResponse;
  return {
    hostId: json.host_id,
    sessionId: json.session_id,
    sessionSecret: json.session_secret,
    expiresAt: new Date(json.expires_at),
  };
}

export const agentEnrollmentPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "agent") return;
  if (!app.config.MULLION_PRIMARY_URL || !app.config.MULLION_ENROLLMENT_TOKEN) return;

  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleRenewal(session: AgentSession) {
    app.agentSession = session;
    if (renewTimer) clearTimeout(renewTimer);
    const ttlMs = session.expiresAt.getTime() - Date.now();
    // Renew at ~50% of TTL (#157's stated cadence) — comfortably before
    // expiry even accounting for a slow renewal round trip. Floored so a
    // clock skew or a very short TTL (e.g. in tests) can't produce a
    // negative/near-zero delay that busy-loops.
    const renewInMs = Math.max(ttlMs / 2, 1_000);
    renewTimer = setTimeout(() => void renew(), renewInMs);
    renewTimer.unref();
  }

  async function renew(): Promise<void> {
    if (stopped) return;
    const current = app.agentSession;
    if (!current) return;
    try {
      const renewed = await callRegister(app, { token: current.sessionId, hostId: current.hostId });
      app.log.info({ hostId: renewed.hostId }, "[agent-enrollment] session renewed");
      scheduleRenewal(renewed);
    } catch (err) {
      // #157's own "primary DB loss -> 401 -> re-register" path: a renewal
      // failure (expired/unknown session on the primary's side, or a
      // transient network blip) falls all the way back to the bootstrap
      // token loop below, rather than retrying the renewal call itself
      // with the now-possibly-invalid session id.
      app.log.warn(
        { err },
        "[agent-enrollment] session renewal failed, falling back to bootstrap re-registration",
      );
      void registerWithRetry();
    }
  }

  async function registerWithRetry(): Promise<void> {
    let attempt = 0;
    while (!stopped) {
      try {
        const session = await callRegister(app, { token: app.config.MULLION_ENROLLMENT_TOKEN });
        app.log.info({ hostId: session.hostId }, "[agent-enrollment] registered with primary");
        scheduleRenewal(session);
        return;
      } catch (err) {
        const delay =
          REGISTER_RETRY_DELAYS_MS[Math.min(attempt, REGISTER_RETRY_DELAYS_MS.length - 1)];
        app.log.warn(
          { err, attempt, delayMs: delay },
          "[agent-enrollment] registration failed, retrying",
        );
        await sleep(delay);
        attempt++;
      }
    }
  }

  // Fire-and-forget from onReady — must not delay listen() the way a
  // primary-down agent otherwise could stall boot for (task-watcher.ts's
  // own boot sweep uses the same pattern, for the same reason).
  app.addHook("onReady", () => {
    void registerWithRetry();
  });

  app.addHook("onClose", () => {
    stopped = true;
    if (renewTimer) clearTimeout(renewTimer);
    app.agentSession = undefined;
  });
});

declare module "fastify" {
  interface FastifyInstance {
    // Issue #245 / roadmap 7.1 — this agent's own current session
    // credential, set once registration succeeds. internal.ts's onRequest
    // gate checks an inbound bearer token against this (in addition to the
    // static MULLION_AGENT_TOKEN check it already does) — additively, per
    // the phase's dual-mode-auth invariant. undefined until the first
    // successful registration, and again after onClose.
    agentSession?: AgentSession;
  }
}

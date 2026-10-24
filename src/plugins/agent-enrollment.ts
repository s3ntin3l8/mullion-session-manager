import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import os from "node:os";
import { reloadDotenvOverrides } from "./env.js";

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

// Issue #248 / roadmap 7.3 — kept short and deliberately not retried: an
// unreachable primary must never hang shutdown, which would be fatal for a
// `systemctl restart` in a deploy (RestartSec=2 in mullion-agent.service
// gives systemd very little patience before it'd consider the unit stuck).
// Best-effort only — the heartbeat fallback (#246) still catches an agent
// that dies before or during this call.
const DEREGISTER_TIMEOUT_MS = 2_000;

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
    // Issue #1721 / roadmap 8.7 — the agent's own platform, free-form and
    // informational ("darwin" | "linux" | "win32" | …). Sent on BOTH the
    // first registration and every renewal: the same body carries both,
    // so one field covers "what this host is" for the whole life of the
    // enrollment. An older primary that strips the field (its schema is
    // `additionalProperties: false`) simply records no platform — never a
    // failed registration.
    platform: process.platform,
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

// Issue #248 / roadmap 7.3 — best-effort only: swallows every failure
// (unreachable primary, timeout, non-2xx) rather than throwing, since
// nothing about agent shutdown may ever block on this succeeding.
async function callDeregister(app: FastifyInstance, session: AgentSession): Promise<void> {
  try {
    const res = await fetch(
      `${app.config.MULLION_PRIMARY_URL.replace(/\/+$/, "")}/api/internal/deregister`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hostId: session.hostId, sessionId: session.sessionId }),
        signal: AbortSignal.timeout(DEREGISTER_TIMEOUT_MS),
        redirect: "manual",
      },
    );
    if (!res.ok) {
      app.log.warn(
        { status: res.status },
        "[agent-enrollment] deregister call rejected (best-effort, ignoring)",
      );
    }
  } catch (err) {
    app.log.warn({ err }, "[agent-enrollment] deregister call failed (best-effort, ignoring)");
  }
}

export const agentEnrollmentPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "agent") return;

  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Guards against two concurrent renewals. The ordinary renewal timer and
  // the resume-triggered revalidation below can otherwise both be in flight
  // at once — a laptop that resumes exactly as its renewal timer fires — and
  // two overlapping renewals would race on app.agentSession and the renewal
  // timer itself.
  let renewInFlight = false;
  // The same guard for the bootstrap loop: a resume can fire while the
  // boot-time registration loop is still retrying against an unreachable
  // primary, and two concurrent loops would double the registration rate
  // and could BOTH succeed — the first session would then never be
  // deregistered.
  let registerInFlight = false;

  // Issue #1719 (roadmap 8.5) — the credential this agent holds is read from
  // the env file ONCE, at boot (env.ts's loadDotenvOverrides). An admin who
  // rotates it on the primary while this laptop is ASLEEP leaves the agent
  // holding a value the primary no longer accepts — and because nothing ever
  // re-reads the file, the agent retries that dead value forever and is
  // permanently stranded until someone restarts it.
  //
  // This re-reads the file and refreshes the credentials the process holds,
  // so the agent recovers WITHOUT a redeploy — the whole point of #1719's
  // "re-establishes a valid credential instead of failing permanently" bullet.
  //
  // BOTH agent flavours are covered, including the manual-token-only one
  // (no MULLION_ENROLLMENT_TOKEN, which returns early further down):
  //   - MULLION_ENROLLMENT_TOKEN is the BOOTSTRAP credential this agent
  //     presents to the primary to obtain a session.
  //   - MULLION_AGENT_TOKEN is the STATIC credential the primary presents to
  //     this agent, checked by routes/internal.ts against app.config. A
  //     rotated static token leaves the agent unable to SERVE the primary
  //     until it restarts, so app.config has to be refreshed too — updating
  //     only the bootstrap token would leave the inbound gate rejecting the
  //     primary's new token.
  function refreshCredentialsFromEnvFile(): boolean {
    const reloaded = reloadDotenvOverrides(app.config.MULLION_HOME);
    let changed = false;

    const agentToken = reloaded.MULLION_AGENT_TOKEN;
    if (agentToken && agentToken !== app.config.MULLION_AGENT_TOKEN) {
      app.config.MULLION_AGENT_TOKEN = agentToken;
      changed = true;
    }

    const enrollmentToken = reloaded.MULLION_ENROLLMENT_TOKEN;
    if (enrollmentToken && enrollmentToken !== app.config.MULLION_ENROLLMENT_TOKEN) {
      app.config.MULLION_ENROLLMENT_TOKEN = enrollmentToken;
      changed = true;
    }

    if (changed) {
      app.log.info("[agent-enrollment] credentials refreshed from the env file");
    }
    return changed;
  }

  // A rejected credential may simply be a stale copy of a rotated one. The
  // error message is the only signal available: callRegister's own throw.
  function isUnauthorized(err: unknown): boolean {
    return err instanceof Error && /\bHTTP 401\b/.test(err.message);
  }

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
    if (renewInFlight) return;
    const current = app.agentSession;
    if (!current) return;
    renewInFlight = true;
    try {
      const renewed = await callRegister(app, { token: current.sessionId, hostId: current.hostId });
      // Recheck after the await — onClose (a real app.close() mid-renewal,
      // e.g. a session-teardown test or an actual shutdown racing this
      // call) may have flipped `stopped` and cleared app.agentSession
      // while callRegister was in flight. Without this, a renewal that
      // resolves just after onClose would resurrect app.agentSession and
      // arm a fresh timer after shutdown began (independent review, PR
      // #528).
      if (stopped) return;
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
    } finally {
      renewInFlight = false;
    }
  }

  async function registerWithRetry(): Promise<void> {
    if (registerInFlight) return;
    registerInFlight = true;
    try {
      let attempt = 0;
      while (!stopped) {
        try {
          const session = await callRegister(app, { token: app.config.MULLION_ENROLLMENT_TOKEN });
          // See the identical recheck in renew() — onClose may have fired
          // while this call was in flight.
          if (stopped) return;
          app.log.info({ hostId: session.hostId }, "[agent-enrollment] registered with primary");
          scheduleRenewal(session);
          return;
        } catch (err) {
          // Issue #1719 — a 401 means the credential was REJECTED, which for a
          // sleeping host is most often a stale copy of a rotated one. Re-read
          // the env file once and, if the value actually changed, retry
          // immediately with the fresh one instead of burning the backoff on a
          // value already proven bad. (A second 401 with an unchanged token
          // falls through to the normal backoff — the retry only ever fires
          // when the file really did change, so this cannot spin.)
          if (isUnauthorized(err) && refreshCredentialsFromEnvFile()) {
            app.log.info(
              "[agent-enrollment] bootstrap credential changed on disk, retrying immediately",
            );
            attempt++;
            continue;
          }
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
    } finally {
      registerInFlight = false;
    }
  }

  // Issue #1719 (roadmap 8.5) — the host just came back from a suspend.
  // Everything the agent holds may have gone stale while it slept: the
  // session credential on the primary's side, and the bootstrap/static
  // credential this process read from the env file at boot. So: refresh the
  // credentials first, then revalidate immediately rather than waiting for
  // the next renewal tick — which, for a credential TTL measured in hours,
  // could be far too late.
  //
  // Registered for EVERY agent, including the manual-token-only one that
  // returns early below: a manual-token agent holds no session to renew, but
  // its static token can still have been rotated, and its inbound gate
  // (routes/internal.ts) reads app.config.
  const unsubscribeResume = app.suspendWatcher.onResume(() => {
    if (stopped) return;
    refreshCredentialsFromEnvFile();
    app.log.info("[agent-enrollment] resumed from a suspend, revalidating the credential");
    if (app.agentSession) {
      void renew();
    } else if (app.config.MULLION_PRIMARY_URL && app.config.MULLION_ENROLLMENT_TOKEN) {
      // Only an ENROLLING agent re-registers from scratch. A manual-token-only
      // agent has no session to establish and no bootstrap credential to
      // present — its whole credential is the static token the refresh above
      // already picked up, so there is nothing to register.
      void registerWithRetry();
    }
  });

  if (!app.config.MULLION_PRIMARY_URL || !app.config.MULLION_ENROLLMENT_TOKEN) {
    // Manual-token-only agent (today's flow, unchanged): it never calls out
    // to the primary, so there is no session to renew — but the resume
    // handler above still refreshes its static token.
    app.addHook("onClose", () => {
      unsubscribeResume();
    });
    return;
  }

  // Fire-and-forget from onReady — must not delay listen() the way a
  // primary-down agent otherwise could stall boot for (task-watcher.ts's
  // own boot sweep uses the same pattern, for the same reason).
  app.addHook("onReady", () => {
    void registerWithRetry();
  });

  // Issue #248 / roadmap 7.3 — awaitable so server.ts's `await app.close()`
  // actually waits for the (bounded, best-effort) deregister call before
  // process.exit(). Only fires if this agent ever successfully registered
  // — a still-retrying agent (never got a session) or one whose plugin body
  // never ran at all (manual-token-only, see the early return above) has
  // nothing to tell the primary and silently does nothing, exactly #248's
  // "degrades to heartbeat-only detection with no error" requirement.
  app.addHook("onClose", async () => {
    stopped = true;
    unsubscribeResume();
    if (renewTimer) clearTimeout(renewTimer);
    const session = app.agentSession;
    app.agentSession = undefined;
    if (!session) return;
    await callDeregister(app, session);
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

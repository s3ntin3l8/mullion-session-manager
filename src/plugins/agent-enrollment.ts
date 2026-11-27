import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import os from "node:os";
import { reloadDotenvOverrides } from "./env.js";
import { formatPrimaryRedirectMessage } from "../services/agent-pairing-redeem.js";
import {
  identityStatePath,
  loadAgentIdentity,
  saveAgentIdentity,
  type AgentIdentity,
} from "../services/agent-identity.js";

// Issue #245 / roadmap 7.1 — the agent-side half of agent-initiated
// registration. Agent-role-only, and inert unless this agent has a stored
// machine identity (a manual-token-only agent — today's flow, unchanged —
// never calls out anywhere). The agent stays DB-less throughout: everything
// here is in-memory, re-established on every boot from the persisted
// `agent-identity.json` that a one-time pairing code redeemed (issue #3437).
// Issue #3577 removed the legacy MULLION_ENROLLMENT_TOKEN bootstrap: with no
// stored identity there is nothing to register with, and src/app.ts refuses
// to boot.
export interface AgentSession {
  hostId: string;
  sessionId: string;
  sessionSecret: string;
  expiresAt: Date;
  // Issue #2568 — the machine credential the primary returned with this
  // session, when it returned one (kept only long enough to persist it).
  machineCredential?: string;
}

interface RegisterResponse {
  host_id: string;
  session_id: string;
  session_secret: string;
  expires_at: string;
  // Issue #2568 — present on every identity-authenticated renewal; absent
  // from an older primary (the stored identity then stays as it is).
  machine_credential?: string;
}

// Thrown for a 401 from the primary so callers can tell "credential rejected"
// from a transient failure without matching message text.
class RegisterRejectedError extends Error {
  constructor(public readonly status: number) {
    super(`registration request failed: HTTP ${status}`);
  }
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

function legacyAdvertiseUrl(app: FastifyInstance): string {
  return `http://${os.hostname()}:${app.config.PORT}`;
}

function isLoopbackListenHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h === "localhost" || h === "::1" || /^127(\.\d{1,3}){3}$/.test(h);
}

// Issue #2572 — what this agent tells the primary about where to reach it, or
// undefined when it advertises nothing and is reached over its outbound
// channel. An explicit MULLION_AGENT_ADVERTISE_URL always wins. Without one, an
// agent that was told to listen on a non-loopback address keeps the old
// hostname:PORT guess (a deployment that set HOST/PORT for inbound use and
// never an advertise URL must not change behaviour on upgrade); one that only
// listens on loopback has no address anyone could dial, so it advertises none.
function resolveAdvertiseUrl(app: FastifyInstance): string | undefined {
  if (app.config.MULLION_AGENT_ADVERTISE_URL) return app.config.MULLION_AGENT_ADVERTISE_URL;
  return isLoopbackListenHost(app.config.HOST) ? undefined : legacyAdvertiseUrl(app);
}

async function callRegister(
  app: FastifyInstance,
  identity: AgentIdentity,
  advertiseUrl: string | undefined = resolveAdvertiseUrl(app),
): Promise<AgentSession> {
  const body = {
    hostId: identity.hostId,
    machineCredential: identity.machineCredential,
    baseUrl: advertiseUrl,
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
    // A primary that predates #2572 requires a baseUrl and answers 400 without
    // one. Fall back to the old guess once so a new agent still registers
    // against it (it will be reached inbound, exactly as before).
    if (res.status === 400 && advertiseUrl === undefined) {
      return callRegister(app, identity, legacyAdvertiseUrl(app));
    }
    throw new RegisterRejectedError(res.status);
  }
  const json = (await res.json()) as RegisterResponse;
  return {
    hostId: json.host_id,
    sessionId: json.session_id,
    sessionSecret: json.session_secret,
    expiresAt: new Date(json.expires_at),
    machineCredential: json.machine_credential,
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

  // Observable retry state (#2691): lets a test (and an operator's debug view)
  // assert "stopped retrying: the identity was rejected" without a timing window.
  const enrollment: AgentEnrollmentState = { state: "idle", failedAttempts: 0 };
  app.agentEnrollment = enrollment;

  let renewTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  // Guards against two concurrent renewals. The ordinary renewal timer and
  // the resume-triggered revalidation below can otherwise both be in flight
  // at once — a laptop that resumes exactly as its renewal timer fires — and
  // two overlapping renewals would race on app.agentSession and the renewal
  // timer itself.
  let renewInFlight = false;
  // The same guard for the registration loop: a resume can fire while the
  // boot-time registration loop is still retrying against an unreachable
  // primary, and two concurrent loops would double the registration rate
  // and could BOTH succeed — the first session would then never be
  // deregistered.
  let registerInFlight = false;

  // Issue #2568 — the persisted identity. Loaded once at boot and kept current
  // as the primary rotates the credential.
  const statePath = identityStatePath(app.config.SESSIONS_DIR);
  let identity: AgentIdentity | null = loadAgentIdentity(statePath);
  // Set when the primary rejected the stored identity. Terminal until the
  // operator pairs the host again: the agent must not silently regain a
  // revoked identity.
  let identityRejected = false;
  let loggedRedirectRejected = false;

  async function persistIdentity(session: AgentSession): Promise<void> {
    if (!session.machineCredential) return;
    const next = { hostId: session.hostId, machineCredential: session.machineCredential };
    try {
      await saveAgentIdentity(statePath, next);
      identity = next;
    } catch (err) {
      // Not fatal: the session works. Keep presenting the last PERSISTED
      // identity (the primary still accepts it via the grace slot), so memory
      // never drifts ahead of disk. The error is logged without the credential.
      app.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        identity
          ? "[agent-enrollment] could not persist the machine identity; keeping the last persisted one (a renewal that returns a credential retries the write)"
          : "[agent-enrollment] could not persist the machine identity and none is stored yet; this agent keeps running on its session and re-claims a credential on the next restart",
      );
    }
  }

  function onIdentityRejected(): void {
    identityRejected = true;
    enrollment.state = "rejected";
    app.log.error(
      { hostId: identity?.hostId },
      `[agent-enrollment] the primary rejected this agent's machine identity (revoked, expired after 90 days unused, or unknown). ` +
        `Not retrying it. To re-enroll, pair this host again: run install.sh with a one-time pairing code ` +
        `(MULLION_AGENT_PAIRING_CODE_STDIN=1 and MULLION_AGENT_PAIRING_FORCE=1) — it overwrites ${statePath} — ` +
        `or stop the agent, delete ${statePath}, and pair it before restarting.`,
    );
  }

  // Issue #1719 (roadmap 8.5) — the static credential this agent holds is read
  // from the env file ONCE, at boot (env.ts's loadDotenvOverrides). An admin
  // who rotates it on the primary while this laptop is ASLEEP leaves the agent
  // holding a value the primary no longer accepts — and because nothing ever
  // re-reads the file, the agent is permanently stranded until someone
  // restarts it.
  //
  // This re-reads the file and refreshes the credential the process holds, so
  // the agent recovers WITHOUT a redeploy. MULLION_AGENT_TOKEN is the STATIC
  // credential the primary presents to this agent, checked by
  // routes/internal.ts against app.config; a rotated static token leaves the
  // agent unable to SERVE the primary until it restarts, so app.config has to
  // be refreshed. The enrolling agent's own credential is the persisted
  // agent-identity.json, which rotates through the primary's renewal response
  // (persistIdentity), not through the env file — issue #3577.
  function refreshCredentialsFromEnvFile(): boolean {
    const reloaded = reloadDotenvOverrides(app.config.MULLION_HOME);
    let changed = false;

    const agentToken = reloaded.MULLION_AGENT_TOKEN;
    if (agentToken && agentToken !== app.config.MULLION_AGENT_TOKEN) {
      app.config.MULLION_AGENT_TOKEN = agentToken;
      changed = true;
    }

    if (changed) {
      app.log.info("[agent-enrollment] credentials refreshed from the env file");
    }
    return changed;
  }

  function isRedirect(err: unknown): err is RegisterRejectedError {
    return err instanceof RegisterRejectedError && err.status >= 300 && err.status < 400;
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
    if (!app.agentSession) return;
    // src/app.ts refuses to boot an enrolling agent without one, so this is
    // only ever null for a manual-token-only agent — which never reaches here.
    const currentIdentity = identity;
    if (!currentIdentity) return;
    renewInFlight = true;
    try {
      const renewed = await callRegister(app, currentIdentity);
      await persistIdentity(renewed);
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
      if (err instanceof RegisterRejectedError && err.status === 401) {
        onIdentityRejected();
        return;
      }
      // #157's own "primary DB loss -> re-register" path: a renewal failure
      // (a transient network blip, or state lost on the primary's side) falls
      // all the way back to the identity re-registration loop below, rather
      // than retrying the renewal call itself with a now-possibly-invalid
      // session id.
      app.log.warn(
        { err },
        "[agent-enrollment] session renewal failed, falling back to identity re-registration",
      );
      void registerWithRetry();
    } finally {
      renewInFlight = false;
    }
  }

  async function registerWithRetry(): Promise<void> {
    if (registerInFlight) return;
    if (identityRejected) return;
    // Issue #3577 — there is no bootstrap token to fall back to. An enrolling
    // agent always has a stored identity (src/app.ts refuses to boot one
    // without); this guard only keeps a manual-token agent's stray call from
    // reaching the primary with no credential.
    const currentIdentity = identity;
    if (!currentIdentity) return;
    registerInFlight = true;
    enrollment.state = "registering";
    try {
      let attempt = 0;
      while (!stopped) {
        try {
          const session = await callRegister(app, currentIdentity);
          await persistIdentity(session);
          // See the identical recheck in renew() — onClose may have fired
          // while this call was in flight.
          if (stopped) return;
          app.log.info({ hostId: session.hostId }, "[agent-enrollment] registered with primary");
          enrollment.state = "registered";
          scheduleRenewal(session);
          return;
        } catch (err) {
          if (err instanceof RegisterRejectedError && err.status === 401) {
            onIdentityRejected();
            return;
          }
          if (isRedirect(err) && !loggedRedirectRejected) {
            // A login gateway in front of the primary answered with a 3xx
            // instead of the API. Logged once per process so the retry loop
            // does not repeat the bare status forever, while keeping the
            // normal backoff alive in case the route/proxy recovers.
            loggedRedirectRejected = true;
            app.log.warn(
              `[agent-enrollment] ${formatPrimaryRedirectMessage("registration failed", err.status)} — the agent reads MULLION_PRIMARY_URL at boot, so restart it after editing .env`,
            );
          }
          enrollment.failedAttempts++;
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
  // session credential on the primary's side, and the static token this
  // process read from the env file at boot. So: refresh the static token
  // first, then revalidate immediately rather than waiting for the next
  // renewal tick — which, for a credential TTL measured in hours, could be
  // far too late.
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
    } else if (app.config.MULLION_PRIMARY_URL && identity) {
      // Only a paired agent re-registers from scratch. A manual-token-only
      // agent has no session to establish and no machine credential to
      // present — its whole credential is the static token the refresh above
      // already picked up, so there is nothing to register.
      void registerWithRetry();
    }
  });

  if (!app.config.MULLION_PRIMARY_URL || !identity) {
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

/** Where this agent's registration loop stands. `rejected` is terminal (the
 * primary refused the stored machine identity; the operator clears it). */
export interface AgentEnrollmentState {
  state: "idle" | "registering" | "registered" | "rejected";
  /** Registrations that failed and were retried with backoff. */
  failedAttempts: number;
}

declare module "fastify" {
  interface FastifyInstance {
    agentEnrollment?: AgentEnrollmentState;
    // Issue #245 / roadmap 7.1 — this agent's own current session
    // credential, set once registration succeeds. internal.ts's onRequest
    // gate checks an inbound bearer token against this (in addition to the
    // static MULLION_AGENT_TOKEN check it already does) — additively, per
    // the phase's dual-mode-auth invariant. undefined until the first
    // successful registration, and again after onClose.
    agentSession?: AgentSession;
  }
}

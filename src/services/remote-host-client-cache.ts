import type { FastifyInstance } from "fastify";
import { getHostRow, decryptToken } from "./host-registry.js";
import { resolveHostTransport } from "./agent-channel-tunnel.js";
import { RemoteHostClient } from "./remote-host-client.js";

// Split out of remote-host-client.ts (its size ratchet): the per-host client
// cache. remote-host-client.ts re-exports getRemoteHostClient, so callers keep
// importing it from there.

// Cached per (app instance, hostId), self-invalidating on
// token/baseUrl/session change (compared against the current DB row on
// every lookup) rather than requiring host-registry.ts to explicitly
// notify this module — keeps the two services free of a circular import.
// sessionIdEnc is included (issue #245 / roadmap 7.1) so a rotated session
// rebuilds the cached client with the fresh credential, same as an edited
// baseUrl/authTokenEnc already does. sessionSecretEnc is included too
// (Hermes review, PR #531): host-registry.ts's issueSession/clearHostSession
// always write/clear sessionIdEnc and sessionSecretEnc together today, so
// this is currently redundant with the sessionIdEnc check — but comparing
// only one of two fields that are SUPPOSED to always change together is
// exactly the kind of place a future partial-update bug would silently
// land, undetected, since nothing here would notice the secret went stale
// while the id didn't.
const clientCache = new WeakMap<
  FastifyInstance,
  Map<
    string,
    {
      client: RemoteHostClient;
      baseUrl: string | null;
      authTokenEnc: string | null;
      sessionIdEnc: string | null;
      sessionSecretEnc: string | null;
    }
  >
>();

// Issue #245 / roadmap 7.1 — a host that has successfully registered
// (claimed or enrolled) has BOTH a session and, possibly, a leftover
// manual authTokenEnc; the session is always preferred once it exists and
// hasn't expired; a null/expired session falls back to the manual token
// (empty string if there's none either — a still-pending enrolled row with
// no session yet, which correctly fails auth loudly rather than silently).
//
// Issue #249 / roadmap 7.5 — sessionSecret rides alongside token, from the
// SAME live-session check, rather than being derived from `token` itself:
// signing must only ever happen for an actual live session, never for the
// static-token fallback branch, and gating both fields on one shared
// condition is what keeps that invariant impossible to accidentally
// desync. sessionSecret is deliberately still null if `sessionSecretEnc`
// is somehow missing despite a live, unexpired sessionIdEnc — a state
// issueSession()/clearHostSession() (host-registry.ts) never actually
// produce, since they always write/clear all three session fields
// together, but if it ever did happen this fails closed (the client signs
// nothing, so the agent's onRequest gate — which requires a signature for
// ANY session-matched request — rejects every request from it) rather than
// silently treating a token-bearing client as a legitimate static one.
function resolveCurrentCredentials(
  app: FastifyInstance,
  row: NonNullable<ReturnType<typeof getHostRow>>,
): { token: string; sessionSecret: string | null } {
  const hasLiveSession =
    row.sessionIdEnc !== null &&
    row.sessionExpiresAt !== null &&
    row.sessionExpiresAt.getTime() > Date.now();
  if (hasLiveSession) {
    return {
      token: app.encryption.decryptString(row.sessionIdEnc!),
      sessionSecret: row.sessionSecretEnc
        ? app.encryption.decryptString(row.sessionSecretEnc)
        : null,
    };
  }
  return { token: decryptToken(app, row), sessionSecret: null };
}

export function getRemoteHostClient(app: FastifyInstance, hostId: string): RemoteHostClient {
  const row = getHostRow(app, hostId);
  // A row with a machine identity but no baseUrl is an outbound-only agent
  // (#2572), reached over its channel; one with neither is not a remote host.
  if (!row || (row.baseUrl === null && row.machineCredentialEnc === null)) {
    throw new Error(`Host ${hostId} has no baseUrl — not a remote host`);
  }

  let hostMap = clientCache.get(app);
  if (!hostMap) {
    hostMap = new Map();
    clientCache.set(app, hostMap);
  }

  const cached = hostMap.get(hostId);
  if (
    cached &&
    cached.baseUrl === row.baseUrl &&
    cached.authTokenEnc === row.authTokenEnc &&
    cached.sessionIdEnc === row.sessionIdEnc &&
    cached.sessionSecretEnc === row.sessionSecretEnc
  ) {
    return cached.client;
  }

  const credentials = resolveCurrentCredentials(app, row);
  const client = new RemoteHostClient({
    hostId,
    baseUrl: row.baseUrl,
    resolveTransport: (operation) => resolveHostTransport(app, hostId, operation),
    token: credentials.token,
    sessionSecret: credentials.sessionSecret,
    // Only a registered (has-or-had-a-session) host gets a refresh
    // callback — retrying a wrong static token on 401 would just fail
    // again identically, so there's nothing to gain and it'd mask the
    // real "check its agent token" error with an extra round trip.
    refreshCredentials: row.sessionIdEnc
      ? () => {
          const fresh = getHostRow(app, hostId);
          return fresh ? resolveCurrentCredentials(app, fresh) : null;
        }
      : undefined,
  });
  hostMap.set(hostId, {
    client,
    baseUrl: row.baseUrl,
    authTokenEnc: row.authTokenEnc,
    sessionIdEnc: row.sessionIdEnc,
    sessionSecretEnc: row.sessionSecretEnc,
  });
  return client;
}

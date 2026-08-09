// Connection-time SSRF pinning (issue #250).
//
// url-guard.ts's isAllowedHttpUrl() is deliberately string-only: it classifies
// IP *literals* at registration/creation time and never resolves DNS. That
// leaves two gaps it documents but cannot close on its own —
//
//   1. a hostname that resolves to a private/loopback/cloud-IMDS address is
//      not caught, because no resolution happens; and
//   2. even a name that resolved safely when it was registered can be rebound
//      afterwards, so the check and the connection describe different hosts.
//
// Both are closed here, and specifically by a validated *lookup* rather than
// by validating a URL again later. `net.connect` opens the socket to exactly
// the address the lookup handed back, so validating inside the lookup makes
// check-and-connect atomic: there is no window in which the name can rebind.
// Wiring it anywhere further out (resolve, check, then fetch by name) would
// just re-open the same race.
//
// The one primitive feeds two transports, because outbound traffic here uses
// both and a dispatcher only covers one of them:
//   - undici `Agent` (`connect.lookup`), passed per call as `dispatcher:` to
//     fetch() — every fetch() site;
//   - `http.Agent`/`https.Agent` (`lookup`), passed as `{ agent }` to
//     `new WebSocket(...)` — every `ws` site, which no Dispatcher can reach.
//
// Deliberately *not* installed via setGlobalDispatcher(): policy is per-call
// (host connections legitimately allow loopback/private, external previews do
// not), and test/services/oidc.integration.test.ts already owns the global
// dispatcher for its MockAgent.
//
// TLS is unaffected: undici derives `servername` from the URL host, never from
// the address the lookup returned (undici/lib/core/connect.js), and
// tls.connect does the same for the `ws` path — so certificates are still
// validated against the hostname, not against the pinned IP.

import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";
import { Agent as UndiciAgent } from "undici";
import { isAllowedHttpUrl, isAllowedIpAddress, type UrlGuardPolicy } from "./url-guard.js";

export const SSRF_BLOCKED_CODE = "MULLION_SSRF_BLOCKED";

/**
 * Thrown when a resolved address (or a URL's own IP literal) falls in a range
 * the caller's policy forbids. Carries the hostname *and* the offending
 * address so callers can log what actually happened — see findSsrfBlock below
 * for why the raw error rarely reaches them intact.
 */
export class SsrfBlockedError extends Error {
  readonly code = SSRF_BLOCKED_CODE;

  constructor(
    readonly hostname: string,
    readonly address: string,
    readonly policy: UrlGuardPolicy,
  ) {
    super(
      `blocked by SSRF guard: ${hostname} resolves to ${address}, ` +
        `which is not permitted under this policy ` +
        `(allowLoopback=${policy.allowLoopback}, allowPrivate=${policy.allowPrivate})`,
    );
    this.name = "SsrfBlockedError";
  }
}

/**
 * Recover an SsrfBlockedError from whatever the transport wrapped it in.
 *
 * A block raised inside `lookup` surfaces to a fetch() caller as
 * `TypeError: fetch failed` with the real error hanging off `.cause`, and
 * `autoSelectFamily` can bundle several attempts into an AggregateError. Every
 * catch site in this codebase funnels connection failures into a generic
 * "unreachable" outcome (HostUnreachableError, `ping` -> false, the preview
 * proxy's 502), so without unwrapping, a *blocked* host is indistinguishable
 * from a *down* host — the heartbeat turns it red and the operator has nothing
 * to debug against. It still fails closed either way; this is what makes the
 * failure legible.
 */
export function findSsrfBlock(err: unknown, depth = 0): SsrfBlockedError | null {
  if (depth > 5 || err === null || typeof err !== "object") return null;
  if (err instanceof SsrfBlockedError) return err;
  const { cause, errors } = err as { cause?: unknown; errors?: unknown };
  if (Array.isArray(errors)) {
    for (const nested of errors) {
      const found = findSsrfBlock(nested, depth + 1);
      if (found) return found;
    }
  }
  return cause === undefined ? null : findSsrfBlock(cause, depth + 1);
}

/**
 * The `dns.lookup` shape createPinnedLookup depends on. Only tests pass one —
 * production always uses the real resolver, so the OS resolver's view
 * (including /etc/hosts and split-horizon DNS) is the one that is enforced.
 */
export type PinnedResolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/**
 * A `lookup` that resolves, validates, and only then hands the address to the
 * socket.
 *
 * Rejects if *any* returned address is disallowed rather than filtering the
 * bad ones out: a resolver answer mixing a public address with 169.254.169.254
 * is an attack signature, not a partially usable result, and a filtered lookup
 * would happily connect to the "good" one and call it safe.
 */
export function createPinnedLookup(
  policy: UrlGuardPolicy,
  resolver: PinnedResolver = dnsLookup,
): LookupFunction {
  return (hostname, options, callback) => {
    // `all: true` is forced for the check regardless of what the caller asked
    // for, so a name with several answers can't hide a bad one behind a good
    // first entry. The caller's own shape is restored below.
    resolver(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", undefined);
        return;
      }
      if (addresses.length === 0) {
        const empty: NodeJS.ErrnoException = new Error(`no addresses resolved for ${hostname}`);
        empty.code = "ENOTFOUND";
        callback(empty, "", undefined);
        return;
      }
      const blocked = addresses.find((entry) => !isAllowedIpAddress(entry.address, policy));
      if (blocked) {
        callback(new SsrfBlockedError(hostname, blocked.address, policy), "", undefined);
        return;
      }
      // Node's `autoSelectFamily` (on by default) always calls lookup with
      // `all: true` and requires the array form back; the single-address form
      // fails there with "Invalid IP address: undefined". Both shapes are
      // handled so this stays correct if that default ever changes.
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function policyKey(policy: UrlGuardPolicy): string {
  return `${policy.allowLoopback}:${policy.allowPrivate}`;
}

// Memoized per policy (four possible combinations, two used in practice) so
// every host shares one connection pool per trust level rather than building a
// fresh agent — and its own pool — on every request.
const dispatchers = new Map<string, UndiciAgent>();
const wsAgents = new Map<string, HttpAgent>();

/** The undici `Agent` to pass as fetch()'s `dispatcher` under this policy. */
export function getPinnedDispatcher(policy: UrlGuardPolicy): UndiciAgent {
  const key = policyKey(policy);
  let agent = dispatchers.get(key);
  if (!agent) {
    agent = new UndiciAgent({ connect: { lookup: createPinnedLookup(policy) } });
    dispatchers.set(key, agent);
  }
  return agent;
}

/** The `http(s).Agent` to pass as `new WebSocket(url, { agent })`. */
export function getPinnedWsAgent(policy: UrlGuardPolicy, url: string | URL): HttpAgent {
  const secure = String(url).startsWith("wss:") || String(url).startsWith("https:");
  const key = `${secure}:${policyKey(policy)}`;
  let agent = wsAgents.get(key);
  if (!agent) {
    const options = { lookup: createPinnedLookup(policy) };
    agent = secure ? new HttpsAgent(options) : new HttpAgent(options);
    wsAgents.set(key, agent);
  }
  return agent;
}

/**
 * Re-run the string-level guard at request time.
 *
 * `lookup` is only consulted for *hostnames* — `fetch("http://169.254.169.254/")`
 * never calls it at all (verified: zero lookup calls for an IP-literal host),
 * so pinning alone would leave literals unguarded on the connect path. This
 * also re-checks a `baseUrl`/`externalUrl` that changed in the database since
 * it was first validated.
 */
export function assertAllowedUrl(url: string | URL, policy: UrlGuardPolicy): void {
  const value = String(url);
  if (isAllowedHttpUrl(value, policy)) return;
  let hostname = value;
  try {
    hostname = new URL(value).hostname;
  } catch {
    // Not parseable as a URL at all — report it verbatim rather than throwing
    // a second, less useful error out of the guard.
  }
  throw new SsrfBlockedError(hostname, hostname, policy);
}

/**
 * Release pooled sockets. Called from the app's shutdown path so keep-alive
 * connections held by these agents can't keep the process alive.
 */
export async function closePinnedConnectors(): Promise<void> {
  const closing = [...dispatchers.values()].map((agent) => agent.close());
  dispatchers.clear();
  for (const agent of wsAgents.values()) agent.destroy();
  wsAgents.clear();
  await Promise.allSettled(closing);
}

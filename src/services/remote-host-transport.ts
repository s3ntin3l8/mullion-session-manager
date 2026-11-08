import crypto from "node:crypto";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  buildCanonicalString,
  hashBody,
  isUnsignedBodyPath,
  sign,
} from "./request-signature.js";
import { channelDownError, requestViaChannel, type HostTransport } from "./agent-channel-tunnel.js";
import { HostRequestError, HostUnreachableError } from "./remote-host-errors.js";
import { assertAllowedUrl, getPinnedDispatcher, getPinnedWsAgent } from "./pinned-connect.js";
import type { UrlGuardPolicy } from "./url-guard.js";

// Split out of remote-host-client.ts (issue #2714, #2404): the transport — how
// a request to one host is addressed, signed, pinned and answered. It is the
// SSRF and bearer-token security boundary for every outbound call the client
// makes, HTTP and WS alike, so it lives in exactly one place: the client's
// other fetch sites (upload, download, preview, the WS attach) take their
// dispatcher, signature headers and credentials from here rather than carrying
// a second copy that could drift.

// Connection-time SSRF pinning policy for host connections (issue #250).
// Identical to what hosts.ts and enrollment.ts accepted when the baseUrl was
// registered — a host on loopback or a private LAN is the normal deployment
// shape, so pinning here only ever blocks link-local/cloud-IMDS/shared-NAT.
// That narrow case is exactly the one that matters: every request below
// attaches this host's bearer token and HMAC signature headers, so a baseUrl
// rebound to an IMDS endpoint would hand those credentials straight to it.
// Rebinding to 10.x/192.168.x remains permitted, by design.
const HOST_URL_POLICY: UrlGuardPolicy = { allowLoopback: true, allowPrivate: true };

export type HostCredentials = { token: string; sessionSecret: string | null };

export class RemoteHostTransport {
  // Empty for a host with no advertised address (issue #2572): an outbound-
  // capable agent that registered without one is reached over its channel
  // only. Every inbound call goes through pinnedDispatcher/pinnedWsOptions,
  // which refuse it as unreachable rather than dialing "".
  readonly baseUrl: string;
  readonly wsBaseUrl: string;
  readonly hostId: string;
  // Mutable (issue #245 / roadmap 7.1) — a registered host's session
  // credential can rotate out from under an already-cached client
  // (getRemoteHostClient's own cache is keyed on the DB row's current
  // credential fields, so a rotation normally rebuilds a fresh client
  // instead, but the retry-on-401 covers the narrow race where the agent's
  // own renewal has already landed and the primary hasn't re-read the row).
  token: string;
  // Issue #249 / roadmap 7.5 — non-null only for a session-credentialed
  // (registered, #245) host with a live session; null for a manually-
  // registered static-token host, which never signs a request at all. Kept
  // as a mutable field, not derived from `token` each call, because it
  // rotates together with `token` on refresh — both come from the same DB
  // row's session fields, and neither is meaningful without the other.
  sessionSecret: string | null;
  // Issue #245 — set only for a session-credentialed (registered) host;
  // absent for a manually-registered static-token one, which never retries
  // on 401 (a wrong static token isn't going to become right by asking the DB
  // again). Issue #249 — returns sessionSecret alongside token because a
  // rotated session changes both together.
  readonly refreshCredentials?: () => HostCredentials | null;
  // Issue #2451 — how this host is reached right now (see
  // agent-channel-tunnel.ts's resolveHostTransport). Absent for a client built
  // without an app (tests, tools): always inbound.
  readonly resolveTransport?: (operation?: string) => HostTransport;

  constructor(opts: {
    hostId: string;
    baseUrl: string | null;
    token: string;
    sessionSecret?: string | null;
    refreshCredentials?: () => HostCredentials | null;
    resolveTransport?: (operation?: string) => HostTransport;
  }) {
    this.hostId = opts.hostId;
    this.baseUrl = (opts.baseUrl ?? "").replace(/\/+$/, "");
    this.wsBaseUrl = this.baseUrl.replace(/^http/, "ws");
    this.token = opts.token;
    this.sessionSecret = opts.sessionSecret ?? null;
    this.refreshCredentials = opts.refreshCredentials;
    this.resolveTransport = opts.resolveTransport;
  }

  // Connection-time SSRF pinning (issue #250) — every outbound call, HTTP and
  // WS alike, goes through one of these two. Both re-run the literal check
  // first: `lookup` is never consulted for an IP-literal host, and baseUrl
  // comes from a DB row that may have changed since registration validated it.
  requireInboundAddress(): void {
    if (this.baseUrl === "") {
      throw new HostUnreachableError(
        this.hostId,
        new Error(
          "this host has no advertised address and this operation is not carried over its outbound channel",
        ),
      );
    }
  }

  pinnedDispatcher(): RequestInit["dispatcher"] {
    this.requireInboundAddress();
    assertAllowedUrl(this.baseUrl, HOST_URL_POLICY);
    return getPinnedDispatcher(HOST_URL_POLICY);
  }

  pinnedWsOptions() {
    this.requireInboundAddress();
    assertAllowedUrl(this.baseUrl, HOST_URL_POLICY);
    return { agent: getPinnedWsAgent(HOST_URL_POLICY, this.wsBaseUrl) };
  }

  /**
   * Issue #249 / roadmap 7.5 — builds the three signature headers for a
   * session-credentialed host; returns `{}` for a manually-registered
   * static-Bearer one (sessionSecret null), so every call site can
   * unconditionally spread this into its own headers object with no
   * if/else of its own. `requestTarget` must be exactly what actually goes
   * out on the wire (path + query, verbatim) — the agent recomputes the
   * canonical string from its own view of the same request and any
   * mismatch simply fails verification, so this has to match precisely,
   * not just semantically.
   */
  signatureHeaders(
    method: string,
    requestTarget: string,
    body: string | Buffer | undefined,
  ): Record<string, string> {
    if (!this.sessionSecret) return {};
    const bodyHashed = !isUnsignedBodyPath(requestTarget);
    const bodyHash = bodyHashed ? hashBody(body ?? "") : "";
    const timestamp = String(Date.now());
    const nonce = crypto.randomBytes(16).toString("hex");
    const canonicalString = buildCanonicalString({
      method,
      requestTarget,
      timestamp,
      nonce,
      bodyHashed,
      bodyHash,
    });
    return {
      [SIGNATURE_HEADER]: sign(this.sessionSecret, canonicalString),
      [TIMESTAMP_HEADER]: timestamp,
      [NONCE_HEADER]: nonce,
    };
  }

  async rawFetch(
    path: string,
    init: RequestInit | undefined,
    timeoutMs: number,
  ): Promise<Response> {
    // Issue #249 / roadmap 7.5 — computed fresh on every call (a new
    // timestamp/nonce each time), never cached/reused across a retry: the
    // 401-retry in request() calls rawFetch() again from scratch specifically
    // so this recomputes under the refreshed token/secret, with its own fresh
    // nonce rather than replaying the first attempt's.
    const sigHeaders = this.signatureHeaders(
      init?.method ?? "GET",
      path,
      init?.body as string | Buffer | undefined,
    );
    try {
      return await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: { ...init?.headers, Authorization: `Bearer ${this.token}`, ...sigHeaders },
        signal: AbortSignal.timeout(timeoutMs),
        // hosts.ts's SSRF guard only validates the *configured* baseUrl —
        // fetch following a redirect by default would still send the
        // bearer token to wherever a 3xx response points, bypassing that
        // guard entirely (e.g. an agent, or a MITM between primary and
        // agent, redirecting to a cloud IMDS endpoint). "manual" surfaces
        // the 3xx as a non-ok response (handled as HostUnreachableError
        // below) instead of ever issuing the follow-up request.
        redirect: "manual",
        // ...and this closes the other half of the same guard: the redirect
        // above can't be followed, and the hostname can't rebind between
        // registration and connect (issue #250).
        dispatcher: this.pinnedDispatcher(),
      });
    } catch (err) {
      throw new HostUnreachableError(this.hostId, err);
    }
  }

  /**
   * How this host is reached for a request/response exchange (#2451, #2620):
   * request(), the file transfers, the HTTP preview forward and the health ping
   * all ask here, so a bound host never has one of them dial the advertised URL.
   */
  requestTransport(): HostTransport {
    return this.resolveTransport?.() ?? { kind: "inbound" };
  }

  async request<T>(path: string, init: RequestInit | undefined, timeoutMs: number): Promise<T> {
    const transport = this.requestTransport();
    if (transport.kind === "channel") {
      return requestViaChannel<T>(this.hostId, transport.channel, path, init, timeoutMs);
    }
    if (transport.kind === "channel-down") {
      // Negotiated the outbound channel and it is down: report it, do not dial
      // the advertised URL (a mutation must not silently change transports).
      throw channelDownError(this.hostId);
    }
    let res = await this.rawFetch(path, init, timeoutMs);
    // Retry-once-on-401 (issue #245 / roadmap 7.1): a session credential
    // this client was built with can go stale if the agent renewed it
    // (agent-enrollment.ts) between when getRemoteHostClient last read the
    // DB row and now. refreshCredentials() re-reads the row live; if
    // either the token or the session secret genuinely changed, one retry
    // with both fresh — never more than one, and never for a manually-
    // registered host (no refreshCredentials at all, see the constructor).
    // The retry calls rawFetch() again rather than replaying the same
    // signed request (issue #249 / roadmap 7.5): re-sending the first
    // attempt's headers would carry a signature computed under the OLD
    // secret (guaranteed to 401 again) and, if that first attempt actually
    // reached the agent before being rejected, a nonce it already recorded
    // (guaranteed to be rejected as a replay).
    if (res.status === 401 && this.refreshCredentials) {
      const fresh = this.refreshCredentials();
      if (fresh && (fresh.token !== this.token || fresh.sessionSecret !== this.sessionSecret)) {
        this.token = fresh.token;
        this.sessionSecret = fresh.sessionSecret;
        res = await this.rawFetch(path, init, timeoutMs);
      }
    }
    if (!res.ok) {
      if (res.status >= 400 && res.status < 500) {
        const body = await res.text().catch(() => `(no response body — HTTP ${res.status})`);
        throw new HostRequestError(this.hostId, res.status, body);
      }
      throw new HostUnreachableError(this.hostId, new Error(`HTTP ${res.status}`));
    }
    // 204 (terminate) has no body — res.json() throws on an empty stream.
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}

import type { WebSocket as NodeWebSocket } from "ws";
import type { AgentChannelStreamKind } from "../shared/agent-channel.js";
import { previewHttpOverChannel } from "./remote-host-channel-transfers.js";
import { HostUnreachableError } from "./remote-host-errors.js";
import type { RemoteHostTransport } from "./remote-host-transport.js";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, NONCE_HEADER } from "./request-signature.js";

// RemoteHostClient previews facet (issue #3289 / #3304; convention in
// remote-host-devices.ts).
//
// The preview forward is the client's one HTTP path that does NOT go through
// request(): the request's headers are seeded from a BROWSER (the preview
// proxy replays them), the answer must reach the caller unchanged (a dev
// server's own 404/500 is not this client's failure to report) and the body
// streams through unbuffered. It therefore issues its own fetch — but its
// bearer token, its signature headers and its SSRF pinning still come from
// the transport (remote-host-transport.ts), the one place that owns them, and
// its channel-versus-inbound choice is the transport's own, unchanged.

// A preview asset request (issue #28 phase 6) can legitimately take longer
// than the client's 5 s default — a dev server compiling a route on first
// request (Vite/webpack's on-demand compilation) is a real, non-error delay
// this proxy must not preempt.
export const PREVIEW_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The request a preview forward carries: the browser's own method and
 * headers, and — for a non-GET/HEAD — its body as an unbuffered stream.
 */
export interface PreviewHttpInit {
  method: string;
  headers: Headers;
  body?: ReadableStream<Uint8Array>;
  duplex?: "half";
}

export interface PreviewsClientDeps {
  /**
   * The host's transport: its bearer token, its signature headers, its SSRF
   * pinning — and its own view of how this host is reached right now (the
   * inbound address, or the outbound channel).
   */
  transport: RemoteHostTransport;
  /** The bearer+signature-authed inbound WebSocket to one `/internal/ws/*` route. */
  openInbound: (requestTarget: string) => NodeWebSocket;
  /**
   * The outbound-channel stream opener (issue #2571) — null when this host is
   * reached inbound, and a refusal (not a fallback) when its channel is down.
   */
  openChannel: (
    kind: AgentChannelStreamKind,
    identity: string,
    query?: Record<string, string>,
  ) => NodeWebSocket | null;
}

export function createPreviewsClient({ transport, openInbound, openChannel }: PreviewsClientDeps) {
  /**
   * The shared half of http() and configuredHttp(): forwards one preview
   * request to the agent, over the outbound channel when this host is reached
   * that way and over the advertised address otherwise.
   */
  async function forwardPreviewRequest(
    requestTarget: string,
    init: PreviewHttpInit,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    // Issue #249 / roadmap 7.5 — `init.headers` here is seeded from a
    // BROWSER-controlled request forwarded through the preview proxy
    // (preview-proxy.ts), unlike every other call site in the client, which
    // only ever builds its own headers from scratch. Delete-then-set, never
    // just set-without-delete: this route's own request body is exempt from
    // hashing (isUnsignedBodyPath), so if the auth/signature headers below
    // were only conditionally set (empty for a static-Bearer host) a
    // browser could otherwise inject its own x-request-signature/
    // -timestamp/-nonce and have them pass straight through unexamined.
    headers.delete("authorization");
    headers.delete(SIGNATURE_HEADER);
    headers.delete(TIMESTAMP_HEADER);
    headers.delete(NONCE_HEADER);
    const t = transport.requestTransport();
    if (t.kind !== "inbound") {
      return previewHttpOverChannel(
        transport.hostId,
        t,
        requestTarget,
        init,
        headers,
        PREVIEW_REQUEST_TIMEOUT_MS,
      );
    }
    headers.set("authorization", `Bearer ${transport.token}`);
    for (const [key, value] of Object.entries(
      transport.signatureHeaders(init.method, requestTarget, undefined),
    )) {
      headers.set(key, value);
    }
    try {
      return await fetch(`${transport.baseUrl}${requestTarget}`, {
        method: init.method,
        headers,
        ...(init.body !== undefined ? { body: init.body, duplex: init.duplex } : {}),
        // "manual" here for the same reason request()'s own comment gives:
        // a followed redirect would resend this bearer token whichever way
        // the redirect's target points, cross-origin-redirect stripping
        // rules notwithstanding — never rely on that instead of just not
        // following. The dev server's own 3xx (relayed by the agent's
        // /internal/preview handler as an ordinary response status, not an
        // HTTP-level redirect of *this* fetch) reaches this method as an
        // ordinary non-ok Response either way, which the caller forwards
        // to the browser unchanged.
        redirect: "manual",
        signal: AbortSignal.timeout(PREVIEW_REQUEST_TIMEOUT_MS),
        dispatcher: transport.pinnedDispatcher(),
      } as RequestInit & { duplex?: "half" });
    } catch (err) {
      throw new HostUnreachableError(transport.hostId, err);
    }
  }

  return {
    /**
     * Forwards an HTTP preview request to this agent's own
     * `/internal/preview/:port/*` (issue #28 phase 6) — the agent, not this
     * process, dials the actual dev server, always on its own loopback (see
     * internal.ts's own loopback assertion; `port` is never a caller-supplied
     * host, only a number this method interpolates into the path). Returns
     * the raw Response regardless of status (a 404/500 from the dev server is
     * not this method's failure to report — only a network-level failure to
     * reach the agent itself is, same distinction request()'s callers rely
     * on but this method can't reuse it for: unlike request(), a non-2xx
     * upstream status must pass through to the caller unchanged, not throw).
     *
     * `body`/`duplex`, when present, stream a non-GET/HEAD request body
     * through to the agent unbuffered — see http-proxy.ts's
     * buildUpstreamRequestBody. Note PREVIEW_REQUEST_TIMEOUT_MS now also
     * bounds upload time for those requests, not just the response: a large
     * POST to a remote-hosted preview can abort mid-upload once it elapses.
     */
    http(port: number, pathAndQuery: string, init: PreviewHttpInit): Promise<Response> {
      return forwardPreviewRequest(`/internal/preview/${port}${pathAndQuery}`, init);
    },

    /**
     * The same forward, but for a NAMED target (the project's own configured
     * preview URL) rather than a port on the agent's loopback.
     */
    configuredHttp(url: string, init: PreviewHttpInit): Promise<Response> {
      return forwardPreviewRequest(
        `/internal/configured-preview?${new URLSearchParams({ url })}`,
        init,
      );
    },

    /**
     * Opens (but does not wait for) a WS connection to this agent's
     * `/internal/ws/configured-preview` — the WS counterpart of
     * configuredHttp() above, and constructed the same bearer-header way as
     * `streams.attach()` (the `ws` package is required for a request header
     * the browser/global WebSocket API can't set). Callers (preview-proxy.ts)
     * own the open/error/close lifecycle and the actual frame piping.
     */
    configuredWs(url: string): NodeWebSocket {
      const viaChannel = openChannel("configured-preview", url, { url });
      if (viaChannel) return viaChannel;
      const requestTarget = `/internal/ws/configured-preview?${new URLSearchParams({ url })}`;
      return openInbound(requestTarget);
    },

    /**
     * Opens (but does not wait for) a WS connection to this agent's
     * `/internal/ws/preview` (issue #28 phase 6) — the WS analog of
     * http() above, and constructed the same bearer-header way as
     * `streams.attach()` (the `ws` package is required for a request header the
     * browser/global WebSocket API can't set). Callers (preview-proxy.ts) own
     * the open/error/close lifecycle and the actual frame piping.
     *
     * No connect timeout, deliberately matching `streams.attach()`'s own gap rather
     * than a bespoke one just for this method (Hermes review, PR #48): if the
     * agent accepts the TCP/WS handshake but its own loopback dev server
     * never answers, this connection can sit open with nothing flowing. A
     * hung *preview* pane is a lower-stakes failure mode than the equivalent
     * for a terminal attach — worth fixing for both together in a follow-up,
     * not diverging on here in isolation.
     */
    ws(port: number, pathAndQuery: string): NodeWebSocket {
      const viaChannel = openChannel("preview", `${port}${pathAndQuery}`, {
        port: String(port),
        path: pathAndQuery,
      });
      if (viaChannel) return viaChannel;
      const query = new URLSearchParams({ port: String(port), path: pathAndQuery });
      const requestTarget = `/internal/ws/preview?${query.toString()}`;
      return openInbound(requestTarget);
    },
  };
}

export type PreviewsClient = ReturnType<typeof createPreviewsClient>;

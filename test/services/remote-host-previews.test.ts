import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WebSocket as NodeWebSocket } from "ws";
import type { AgentChannelStreamKind } from "../../src/shared/agent-channel.js";
import type { HostTransport } from "../../src/services/agent-channel-tunnel.js";
import {
  PREVIEW_REQUEST_TIMEOUT_MS,
  createPreviewsClient,
} from "../../src/services/remote-host-previews.js";
import type { RemoteHostTransport } from "../../src/services/remote-host-transport.js";
import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from "../../src/services/request-signature.js";

// The previews facet behind RemoteHostClient.previews (#3289 / #3304): the
// budget the preview forward gives itself, the request targets it uses, the
// header scrub it owns and the two preview WebSocket kinds. The primary-side
// behaviour built on them is in preview-proxy.test.ts and
// agent-channel-transfers.test.ts.

const { previewHttpOverChannelMock } = vi.hoisted(() => ({
  previewHttpOverChannelMock: vi.fn(),
}));

// The facet's one channel path: the HTTP preview forward over the outbound
// channel (issue #2620). Mocked here because that path has no AbortSignal to
// observe — the budget only shows up as the idle timeout handed over.
vi.mock("../../src/services/remote-host-channel-transfers.js", () => ({
  previewHttpOverChannel: previewHttpOverChannelMock,
}));

const HOST_ID = "host-1";
const BASE_URL = "http://host.invalid";

/**
 * The facet asks its transport for exactly this much: the host id, the
 * advertised address, the bearer token, the signature headers, the pinned
 * dispatcher and how this host is reached right now.
 */
function fakeTransport(
  opts: {
    requestTransport?: () => HostTransport;
    signatureHeaders?: () => Record<string, string>;
  } = {},
): RemoteHostTransport {
  return {
    hostId: HOST_ID,
    baseUrl: BASE_URL,
    token: "the-token",
    requestTransport: opts.requestTransport ?? (() => ({ kind: "inbound" })),
    signatureHeaders: opts.signatureHeaders ?? (() => ({})),
    pinnedDispatcher: () => undefined,
  } as unknown as RemoteHostTransport;
}

const unusedOpenInbound = () => {
  throw new Error("unexpected openInbound call");
};

describe("remote-host-previews", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue(new Response("upstream body", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    previewHttpOverChannelMock.mockResolvedValue(new Response("channel body", { status: 200 }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    previewHttpOverChannelMock.mockReset();
  });

  it("gives the preview forward a budget of its own on both HTTP targets", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const previews = createPreviewsClient({
      transport: fakeTransport(),
      openInbound: unusedOpenInbound,
      openChannel: () => null,
    });

    await previews.http(5173, "/index.html", { method: "GET", headers: new Headers() });
    await previews.configuredHttp("http://app.local/", { method: "GET", headers: new Headers() });

    // The client's own default is 5 s (REQUEST_TIMEOUT_MS). A dev server
    // compiling a route on first request is a real, non-error delay this
    // proxy must not preempt, so the preview forward carries a longer one.
    expect(PREVIEW_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(timeoutSpy.mock.calls.map(([ms]) => ms)).toEqual([
      PREVIEW_REQUEST_TIMEOUT_MS,
      PREVIEW_REQUEST_TIMEOUT_MS,
    ]);
    // A host reached inbound: the agent's own preview routes.
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${BASE_URL}/internal/preview/5173/index.html`,
      `${BASE_URL}/internal/configured-preview?url=http%3A%2F%2Fapp.local%2F`,
    ]);
  });

  it("strips a browser-supplied auth/signature header before setting its own", async () => {
    const previews = createPreviewsClient({
      transport: fakeTransport({
        signatureHeaders: () => ({
          [SIGNATURE_HEADER]: "own-signature",
          [TIMESTAMP_HEADER]: "111",
          [NONCE_HEADER]: "own-nonce",
        }),
      }),
      openInbound: unusedOpenInbound,
      openChannel: () => null,
    });

    // The headers here are seeded from a BROWSER-controlled request forwarded
    // through the preview proxy (issue #249 / roadmap 7.5): a browser must not
    // be able to inject its own auth/signature headers and have them survive
    // to the outbound request.
    await previews.http(5173, "/index.html", {
      method: "GET",
      headers: new Headers({
        authorization: "Bearer attacker-controlled",
        [SIGNATURE_HEADER]: "attacker-controlled-signature",
        [TIMESTAMP_HEADER]: "attacker-controlled-timestamp",
        [NONCE_HEADER]: "attacker-controlled-nonce",
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get("authorization")).toBe("Bearer the-token");
    expect(init.headers.get(SIGNATURE_HEADER)).toBe("own-signature");
    expect(init.headers.get(TIMESTAMP_HEADER)).toBe("111");
    expect(init.headers.get(NONCE_HEADER)).toBe("own-nonce");
  });

  it("drops a browser-injected signature header entirely for a static-token host", async () => {
    // A manually-registered host never signs a request (no session secret),
    // so its own signature headers are empty — the injected ones must be
    // gone rather than passed through unexamined.
    const previews = createPreviewsClient({
      transport: fakeTransport(),
      openInbound: unusedOpenInbound,
      openChannel: () => null,
    });

    await previews.http(5173, "/index.html", {
      method: "GET",
      headers: new Headers({
        [SIGNATURE_HEADER]: "attacker-controlled-signature",
        [TIMESTAMP_HEADER]: "attacker-controlled-timestamp",
        [NONCE_HEADER]: "attacker-controlled-nonce",
      }),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, { headers: Headers }];
    expect(init.headers.get("authorization")).toBe("Bearer the-token");
    expect(init.headers.has(SIGNATURE_HEADER)).toBe(false);
    expect(init.headers.has(TIMESTAMP_HEADER)).toBe(false);
    expect(init.headers.has(NONCE_HEADER)).toBe(false);
  });

  it("forwards the preview over the outbound channel with the same budget", async () => {
    const channel = { kind: "channel", channel: {} } as unknown as HostTransport;
    const previews = createPreviewsClient({
      transport: fakeTransport({ requestTransport: () => channel }),
      openInbound: unusedOpenInbound,
      openChannel: () => null,
    });

    await previews.http(5173, "/app.js", { method: "GET", headers: new Headers() });

    expect(previewHttpOverChannelMock).toHaveBeenCalledTimes(1);
    const [hostId, transport, requestTarget, , , timeoutMs] = previewHttpOverChannelMock.mock
      .calls[0] as [string, HostTransport, string, unknown, Headers, number];
    expect(hostId).toBe(HOST_ID);
    expect(transport).toBe(channel);
    expect(requestTarget).toBe("/internal/preview/5173/app.js");
    expect(timeoutMs).toBe(PREVIEW_REQUEST_TIMEOUT_MS);
    // A host reached over its channel is never dialled at its address.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("opens the preview WebSockets on the inbound route when the host has no channel", () => {
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const previews = createPreviewsClient({
      transport: fakeTransport(),
      openInbound,
      openChannel: () => null,
    });

    previews.ws(5173, "/hmr");
    previews.configuredWs("http://app.local/");

    expect(openInbound.mock.calls.map(([target]) => target)).toEqual([
      "/internal/ws/preview?port=5173&path=%2Fhmr",
      "/internal/ws/configured-preview?url=http%3A%2F%2Fapp.local%2F",
    ]);
  });

  it("prefers the outbound channel for the preview WebSockets when the host has one", () => {
    const viaChannel = {} as NodeWebSocket;
    const openChannel = vi.fn(
      (
        _kind: AgentChannelStreamKind,
        _identity: string,
        _query?: Record<string, string>,
      ): NodeWebSocket => viaChannel,
    );
    const openInbound = vi.fn((target: string) => target as unknown as NodeWebSocket);
    const previews = createPreviewsClient({
      transport: fakeTransport(),
      openInbound,
      openChannel,
    });

    expect(previews.ws(5173, "/hmr")).toBe(viaChannel);
    expect(previews.configuredWs("http://app.local/")).toBe(viaChannel);

    // The channel kind and identity are what count the preview WebSocket
    // against the channel's own preview cap (agent-channel-streams.ts).
    expect(
      openChannel.mock.calls.map(([kind, identity, query]) => [kind, identity, query]),
    ).toEqual([
      ["preview", "5173/hmr", { port: "5173", path: "/hmr" }],
      ["configured-preview", "http://app.local/", { url: "http://app.local/" }],
    ]);
    expect(openInbound).not.toHaveBeenCalled();
  });
});

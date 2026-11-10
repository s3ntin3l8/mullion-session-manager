import {
  normalizePreviewDestination,
  CONFIGURED_PREVIEW_POLICY,
} from "../services/preview-targets.js";
import { getPinnedDispatcher } from "../services/pinned-connect.js";
import type { FastifyInstance } from "fastify";
import { Readable } from "node:stream";
import { pingDevServer } from "./projects.js";
import { registerProbeRoutes } from "./internal-probes.js";
import {
  acceptAttachStream,
  acceptConfiguredPreviewStream,
  acceptEventsStream,
  acceptPreviewStream,
  acceptSshAgentStream,
  attachQueryError,
  configuredPreviewQueryError,
  parsePort,
  previewQueryError,
  resolveLoopbackPreviewUrl,
} from "../services/internal-streams.js";
import { AGENT_CHANNEL_AUTH_HEADER } from "../services/agent-channel-tunnel.js";
import { acceptControlRelayConnection } from "../plugins/control-relay.js";
import {
  MAX_UPLOAD_BYTES,
  extensionForMime,
  matchesMagicBytes,
  saveSessionFileUpload,
  saveSessionUpload,
  uploadRetentionMs,
} from "../services/session-upload.js";
import { buildUpstreamRequestHeaders, relayFetchResponse } from "../services/http-proxy.js";
import { timingSafeTokenMatch } from "../services/crypto-utils.js";
import { matchesStaticAgentCredential } from "../services/internal-agent-auth.js";
import {
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  NONCE_HEADER,
  NONCE_TTL_MS,
  buildCanonicalString,
  hashBody,
  isTimestampFresh,
  isUnsignedBodyPath,
  verify,
} from "../services/request-signature.js";
import { registerBrowserRoutes } from "./internal-browser.js";
export { buildAgentConfig } from "./internal-config.js";
import { registerConfigRoutes } from "./internal-config.js";
import { registerGitRoutes } from "./internal-git.js";
import { registerProjectFilesRoutes } from "./internal-project-files.js";
import { registerWorktreeRoutes } from "./internal-worktrees.js";
import { registerSessionRoutes } from "./internal-sessions.js";
import { INTERNAL_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots } from "./internal-roots.js";

// A generous, explicit cap for a proxied request body — self-documenting
// more than load-bearing: Fastify's own bodyLimit check compares against
// "content-length", and the primary's own hop (preview-proxy.ts) always
// strips that header (see http-proxy.ts's HOP_BY_HOP_REQUEST_HEADERS) before
// forwarding here, so this route always sees chunked framing and Fastify's
// check never actually fires. A true cap would need to count bytes as the
// stream is piped through — left as a known gap, not attempted here.
const MAX_PREVIEW_BODY_BYTES = 50 * 1024 * 1024;

declare module "fastify" {
  interface FastifyRequest {
    // Issue #249 / roadmap 7.5 — see internalRoutes' own onRequest hook for
    // why this is frozen there rather than re-derived in preValidation.
    mullionSignatureSecret: string | null;
  }
}

/**
 * The token-gated API a DB-less "agent" role (issue #26) exposes to a
 * primary: project discovery, actions/dock resolution, agent detection, and
 * PTY spawn/attach/terminate/liveness — all scoped to this host's own
 * filesystem and app.pty, with no DB anywhere in this module. Only
 * registered when MULLION_ROLE=agent (see src/app.ts).
 */
export async function internalRoutes(app: FastifyInstance) {
  // Every route below — including the /internal/ws/attach WS upgrade, since
  // onRequest fires before that upgrade completes (the same guarantee
  // terminal.ts's own preValidation relies on for session-status gating) —
  // requires a bearer token. This hook is registered in this plugin's own
  // encapsulated context (not via fastify-plugin), so it stays scoped to
  // /internal/* and never leaks onto /health or anything else registered
  // outside this file.
  //
  // Issue #245 / roadmap 7.1 — additive dual-mode auth, the phase's hard
  // invariant: the original static MULLION_AGENT_TOKEN check (unchanged,
  // works exactly as it always has for a manually-registered host) OR a
  // match against this agent's own current registered session id
  // (app.agentSession, set by agent-enrollment.ts once registration
  // succeeds — undefined for a manual-token-only agent, so this branch is
  // simply never reachable there). Neither check alone becomes weaker; a
  // request just now has two possible ways to pass instead of one.
  // Issue #249 / roadmap 7.5 — per-request state threaded from onRequest to
  // the preValidation hook below. NOT re-derived there from app.agentSession
  // (the obvious-looking alternative): app.agentSession can rotate out from
  // under a single request between these two hooks (a renewal completing in
  // the async gap between them), and re-checking the bearer token against
  // whatever the row now holds could silently reclassify a request that WAS
  // session-matched (and therefore signature-required) in onRequest as
  // "static-Bearer, nothing to verify" in preValidation — skipping the
  // signature check entirely for a request that must have one. Freezing the
  // secret onRequest actually authorized against, once, is what closes that
  // race. null means "no signature required" (static-Bearer match, or no
  // match reached this point at all).
  app.decorateRequest("mullionSignatureSecret", null);

  // Issue #245 / roadmap 7.1 — additive dual-mode auth, the phase's hard
  // invariant: the original static MULLION_AGENT_TOKEN check (unchanged,
  // works exactly as it always has for a manually-registered host) OR a
  // match against this agent's own current registered session id
  // (app.agentSession, set by agent-enrollment.ts once registration
  // succeeds — undefined for a manual-token-only agent, so this branch is
  // simply never reachable there). Neither check alone becomes weaker; a
  // request just now has two possible ways to pass instead of one.
  app.addHook("onRequest", async (request, reply) => {
    const header = request.headers.authorization;
    const provided = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
    const matchesStaticToken = matchesStaticAgentCredential(app, request, provided);
    // Hermes review, PR #528: the TTL must actually bound a leaked session
    // credential on THIS (accepting) side too, not just on the issuing
    // side (resolveCurrentCredentials/rotateSession already check it). Without
    // this, a primary that's down or unreachable — exactly the scenario
    // agent-enrollment.ts's renewal-retry loop exists for — would leave a
    // stale, past-TTL session id accepted here indefinitely, since nothing
    // clears app.agentSession just because time passed.
    const matchesSession =
      app.agentSession !== undefined &&
      app.agentSession.expiresAt.getTime() > Date.now() &&
      // Issue #1059 — both fixed-length (server-minted sessionId vs
      // inbound bearer), same fixed-length-token assumption as the static
      // check above.
      timingSafeTokenMatch(provided, app.agentSession.sessionId);
    if (!matchesStaticToken && !matchesSession) {
      return reply.unauthorized("invalid or missing agent token");
    }

    // Issue #249 / roadmap 7.5 — a session-authenticated request MUST also
    // carry a valid signature; a manually-registered static-Bearer request
    // never needs one — today's flow, byte-for-byte unchanged. Gated on
    // WHICH credential matched, never on whether signature headers merely
    // happen to be present: presence-driven would let a leaked session id,
    // replayed WITHOUT signature headers, silently fall through to the
    // weaker static-token path instead of being rejected outright.
    if (!matchesSession) return;

    const sigHeader = request.headers[SIGNATURE_HEADER];
    const tsHeader = request.headers[TIMESTAMP_HEADER];
    const nonceHeader = request.headers[NONCE_HEADER];
    if (
      typeof sigHeader !== "string" ||
      typeof tsHeader !== "string" ||
      typeof nonceHeader !== "string"
    ) {
      return reply.unauthorized("signed request required");
    }
    if (!isTimestampFresh(tsHeader)) {
      // Logged distinguishably from a rejected/forged signature (see the
      // preValidation hook below) — an agent whose clock simply isn't
      // NTP-synced is the single most likely field failure of this
      // feature, and it must not read identically to an actual attack in
      // the logs.
      app.log.warn(
        { tsHeader, now: Date.now() },
        "[request-signature] rejected: timestamp outside the drift window (clock drift, or a stale/forged request)",
      );
      return reply.unauthorized("stale or invalid timestamp");
    }
    // Recorded here, not deferred to preValidation: a request that fails
    // the signature check below still burns its nonce (nonce-store.ts's
    // own doc comment explains why), and the timestamp/nonce checks don't
    // need the request body, so there's no reason to delay them.
    if (!app.requestNonceStore?.checkAndRecord(nonceHeader, NONCE_TTL_MS)) {
      return reply.unauthorized("replayed request");
    }

    // Freeze the secret this request was actually authorized against — see
    // the decorateRequest comment above.
    request.mullionSignatureSecret = app.agentSession!.sessionSecret;
  });

  // Issue #249 / roadmap 7.5 — the body-hash half of signature
  // verification. Deferred to preValidation because request.body isn't
  // parsed yet at onRequest time (see the phase plan's D3 design notes);
  // registered globally here (not per-route) so it covers every /internal/*
  // route uniformly, the same encapsulation-inheritance reasoning the
  // top-of-file comment gives for the onRequest hook above — including the
  // WS-upgrade routes below, each of which already relies on ITS OWN
  // route-level preValidation running before the upgrade completes.
  // Global hooks registered via app.addHook always run before a route's own
  // preValidation option, so this is guaranteed to reject a bad signature
  // before any of those routes' own checks (or their handlers) ever run.
  //
  // CodeQL (js/missing-rate-limiting) flags this hook itself as "performs
  // authorization but isn't rate-limited" — a false positive from its
  // dataflow analysis not tracing across the hook/route boundary: every
  // route this hook actually protects already carries its own
  // `config: { rateLimit: ... }` (INTERNAL_RATE_LIMIT below, or a tighter
  // one), same as every other authorization check in this file; a Fastify
  // hook registered via app.addHook has no route config of its own to
  // attach one to, and duplicating this check into all ~40 routes instead
  // of one shared hook would be strictly worse. Dismissed as a false
  // positive (not suppressed) — see the PR.
  app.addHook("preValidation", async (request, reply) => {
    // Two DIFFERENT null-ish states here, deliberately not collapsed into
    // one `== null` check (Hermes review, PR #531, and a mistake caught by
    // this file's own test for it): `null` is the documented sentinel for
    // "no session matched, static-Bearer path, no signature needed" — a
    // legitimate skip. `undefined` means a session DID match but its
    // sessionSecret was missing/malformed (AgentSession.sessionSecret is
    // typed string, never optional, but a primary predating #528 could
    // still send a register response with no session_secret field at all)
    // — treating that the same as `null` would SKIP verification entirely
    // for a session-authenticated request, a real bypass; treating it as
    // "verify anyway" would throw inside crypto.createHmac (a 500). Neither
    // is right — this must fail closed with the same clean 401 every other
    // rejection reason in this hook gives.
    if (request.mullionSignatureSecret === null) return; // static-Bearer path.
    if (request.mullionSignatureSecret === undefined) {
      // Hermes review, PR #531: a distinct message from the "signed request
      // required" one below — THIS request was in fact properly signed;
      // the problem is server-side (this agent's own registered session
      // has no usable secret), not a client omission. Conflating the two
      // would mislead debugging on the one side that can't see why.
      return reply.unauthorized("invalid session credential");
    }

    // onRequest already required these to be present for a session-matched
    // request (and rejected otherwise) — re-checked here only to satisfy
    // the type checker on request.headers' loose typing, not because this
    // is expected to actually fail.
    const sigHeader = request.headers[SIGNATURE_HEADER];
    const tsHeader = request.headers[TIMESTAMP_HEADER];
    const nonceHeader = request.headers[NONCE_HEADER];
    if (
      typeof sigHeader !== "string" ||
      typeof tsHeader !== "string" ||
      typeof nonceHeader !== "string"
    ) {
      return reply.unauthorized("signed request required");
    }

    // Same path both sides independently check against the SAME shared
    // allowlist (request-signature.ts) — see that module's own comment on
    // why bodyHashed is never itself transmitted.
    //
    // Hermes review, PR #531 — the invariant this body-hash comparison
    // actually depends on: JSON.stringify(request.body) here must
    // byte-match what the client hashed, which was JSON.stringify() of the
    // SAME plain object it then sent as this request's body
    // (remote-host-client.ts's ~35 request()-based call sites all build
    // their body this way; see also routes/webhooks.ts's own identical
    // re-stringify-to-verify shape for GitHub's webhook signatures). This
    // holds for the flat, string/number-keyed JSON bodies every current
    // /internal/* route actually receives, but isn't guaranteed in
    // general — a raw non-JSON string body, or a body containing an
    // integer key/value at the edge of what JSON round-trips exactly,
    // could byte-diverge on reserialization and fail signature
    // verification even though the client signed the truth. Fails CLOSED
    // (401) if that ever happens, never open — but a future route with a
    // body shape outside "flat object, JSON.stringify both ends" should
    // route through bodyHashed: false (request-signature.ts's allowlist)
    // instead of assuming this holds.
    const bodyHashed = !isUnsignedBodyPath(request.url);
    const bodyString = bodyHashed
      ? request.body === undefined
        ? ""
        : JSON.stringify(request.body)
      : "";
    const canonicalString = buildCanonicalString({
      method: request.method,
      requestTarget: request.url,
      timestamp: tsHeader,
      nonce: nonceHeader,
      bodyHashed,
      bodyHash: bodyHashed ? hashBody(bodyString) : "",
    });
    if (!verify(request.mullionSignatureSecret, canonicalString, sigHeader)) {
      return reply.unauthorized("invalid signature");
    }
  });

  registerConfigRoutes(app);

  // #2306 capabilities and the #2248 protocol handshake (inside this plugin's
  // auth hook, hence registered from here).
  registerProbeRoutes(app, INTERNAL_RATE_LIMIT);

  registerGitRoutes(app);
  registerProjectFilesRoutes(app);
  registerWorktreeRoutes(app);
  registerSessionRoutes(app);

  // The agent-side counterpart to POST /api/sessions/:id/uploads (issue
  // #68): writes a pasted/attached image under a session's cwd on THIS
  // host's filesystem — where the CLI reading it back by path actually
  // runs, for a remote-hosted project. cwd/mime travel as query params (a
  // raw-body POST has no room for a JSON envelope alongside the image
  // bytes); the request body is the image itself. cwd is confined to this
  // agent's own PROJECTS_ROOTS via resolveWithinRoots — the same barrier
  // /internal/actions, /internal/dock, and /internal/github-repo already
  // apply to a caller-supplied cwd. Unlike those read-only routes (and
  // unlike /internal/sessions/ws/attach's exec-only use of cwd), this route
  // actually creates a directory and writes a file, so an unrestricted cwd
  // here is a real filesystem-write sink, not just a read path — CodeQL
  // flagged exactly that (uncontrolled data in a path expression reaching
  // writeFileSync/mkdirSync in session-upload.ts). Scoped to this plugin's
  // own encapsulated context, so it never affects how any other route file
  // parses its own request bodies.
  app.addContentTypeParser(/^image\//, { parseAs: "buffer" }, (_req, body, done) => {
    done(null, body);
  });
  // Generic-file mode (drag & drop of any file type): the body is the raw
  // file, the original name travels as the `name` query param.
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_req, body, done) => {
      done(null, body);
    },
  );

  app.post<{ Querystring: { cwd?: string; mime?: string; name?: string } }>(
    "/internal/uploads",
    { ...INTERNAL_RATE_LIMIT, bodyLimit: MAX_UPLOAD_BYTES },
    async (request, reply) => {
      const { cwd, mime, name } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      if (mime && name) return reply.badRequest("mime and name are mutually exclusive");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const retentionMs = uploadRetentionMs(app.config);
      // Same signal as POST /api/sessions/:id/uploads: generic mode is chosen
      // by Content-Type, so an image Content-Type can never reach it (and skip
      // the magic-byte check) just by adding a `name`.
      const isGenericFile =
        request.headers["content-type"]?.split(";")[0]?.trim() === "application/octet-stream";
      if (isGenericFile) {
        if (!name) return reply.badRequest("name query param is required for a generic upload");
        if (!Buffer.isBuffer(request.body)) return reply.badRequest("expected a raw file body");
        return { path: saveSessionFileUpload(resolvedCwd, request.body, name, retentionMs) };
      }
      if (!mime) return reply.badRequest("mime query param is required for an image upload");
      if (!extensionForMime(mime)) return reply.badRequest(`Unsupported image type: ${mime}`);
      if (!Buffer.isBuffer(request.body)) return reply.badRequest("expected a raw image body");
      // Content check, not just Content-Type: rejects a body whose actual
      // leading bytes don't match the claimed image format — a client can't
      // smuggle arbitrary content onto disk under an image mime type.
      if (!matchesMagicBytes(request.body, mime)) {
        return reply.badRequest("File content does not match the declared image type");
      }

      const uploadPath = saveSessionUpload(resolvedCwd, request.body, mime, retentionMs);
      return { path: uploadPath };
    },
  );

  // The DB-less counterpart to /ws/terminal (terminal.ts): the primary
  // resolves `cwd`/`command` from its own DB (a session's row, falling back
  // to its project's), then passes them straight through as query params —
  // this agent has nowhere else to get them from. Everything past that is
  // identical: attachSocketToSession's getOrCreate is the same idempotent
  // spawn-or-reattach /ws/terminal itself relies on for the post-restart
  // reattach case, so this endpoint needs no separate "attach only, don't
  // spawn" variant.
  app.get(
    "/internal/ws/attach",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const error = attachQueryError(request.query as Record<string, string | undefined>);
        if (error !== null) return reply.badRequest(error);
      },
    },
    (socket, req) => {
      acceptAttachStream(app, socket, req.query as Record<string, string | undefined>);
    },
  );

  // The DB-less counterpart to /ws/events (routes/events.ts) — issue #166's
  // multi-host twin. The primary opens one of these per registered remote
  // host and relays its events into its own aggregated /ws/events stream
  // (see events.ts's own comment on that relay). Mostly no query params:
  // like the primary's own /ws/events, this is one aggregated stream
  // covering every session THIS agent tracks, not a per-session attach —
  // attachLocalEventsSocket is the exact same shared core the primary's own
  // route uses, just reused against this agent's own app.pty instead.
  //
  // Issue #1459 — the one opt-in exception: `?cursors=1`, set only by a NEW
  // primary's own relayRemoteEventsHost (routes/events.ts,
  // RemoteHostClient.openEventsStream's own doc comment explains why this is
  // opt-in rather than unconditional). When present, this ALSO sends this
  // agent's own `cursors` frame first and joins this agent's own
  // seenSubscribers broadcast set — attachCursorsAndSeenBroadcast is the
  // exact same helper attachAggregatedEventsSocket (routes/events.ts) uses
  // for the primary's own local browsers, reused here against THIS agent's
  // own `app` (a distinct FastifyInstance from the primary's, so the
  // broadcast set this joins is scoped to this agent's own internal
  // connections, never leaking across processes). Without the flag (an old
  // primary, or a primary not currently relaying with cursors on), behavior
  // is byte-for-byte unchanged from before this issue.
  app.get<{ Querystring: { cursors?: string } }>(
    "/internal/ws/events",
    { websocket: true, config: INTERNAL_RATE_LIMIT.config },
    (socket, req) => acceptEventsStream(app, socket, req.query),
  );

  // Issue #820 — the agent-side half of the SSH-agent bridge's fan-out
  // leg: the primary dials THIS route (mirroring /internal/ws/attach and
  // /internal/ws/events above — an agent never dials out for its own
  // sake, the primary always dials in) to carry SSH-agent-protocol
  // traffic for whatever local unix-socket connections this agent's own
  // ssh-agent.sock (plugins/ssh-agent.ts, PR5a's materializeSshAgentSocket)
  // accepts. Registered inside internalRoutes() like every other
  // /internal/ws/* route specifically to inherit its bearer+signing
  // onRequest gate (see this function's own top-of-file comment) — a
  // route registered outside that scope would be unauthenticated.
  //
  // Load-bearing invariant for whatever primary-side code eventually dials
  // this (PR5c): it must dial ONLY when a bridge is actually connected for
  // THIS agent host, and must disconnect promptly when that bridge goes
  // away. This route has no independent way to know whether a real laptop
  // helper is reachable on the other end — the sole signal a locally
  // materialized socket's `openChannel` callback (ssh-agent-socket.ts) has
  // for "no bridge reachable, close immediately" is whether ANY primary
  // connection is currently live here at all. Dialing in eagerly, for a
  // health check, or before actually confirming a bridge is live would
  // silently defeat that fail-fast behavior and hang a connecting `ssh`
  // client instead.
  app.get(
    "/internal/ws/ssh-agent",
    { websocket: true, config: INTERNAL_RATE_LIMIT.config },
    (socket) => acceptSshAgentStream(app, socket),
  );

  // Issue #1656 — the agent half of the control relay's transport: the
  // primary dials THIS route (an agent never dials out) and the mux it
  // carries is what relay.sock (plugins/control-relay.ts) opens a channel on
  // for each session connection. Inside internalRoutes() for the same reason
  // as /internal/ws/ssh-agent above: it inherits the bearer + signing gate.
  // Even parity here, odd on the primary's dial (control-relay-fanout.ts).
  app.get(
    "/internal/ws/control-relay",
    { websocket: true, config: INTERNAL_RATE_LIMIT.config },
    (socket) => acceptControlRelayConnection(app, socket),
  );

  // CodeQL alert #434 (request-forgery) dismissed as a false positive:
  // private/LAN access by the authenticated primary is intentional here.
  // URL validation + DNS pinning + manual redirects constrain that access.
  // Named project settings explicitly authorize destinations beyond loopback.
  // This is a separate authenticated transport: legacy preview routes retain
  // their literal-loopback contract. The primary resolves a saved target ID;
  // browser callers cannot supply this URL through the public preview API.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => done(null, payload));
    scope.all<{ Querystring: { url?: string } }>(
      "/internal/configured-preview",
      { ...INTERNAL_RATE_LIMIT, bodyLimit: MAX_PREVIEW_BODY_BYTES },
      async (request, reply) => {
        reply.header("x-mullion-preview-transport", "named");
        const destination = normalizePreviewDestination(request.query.url ?? "");
        if (!destination) return reply.badRequest("Invalid configured preview destination");
        const upstream = new URL(destination);
        const headers = buildUpstreamRequestHeaders(request, upstream.host, [
          "authorization",
          AGENT_CHANNEL_AUTH_HEADER,
          SIGNATURE_HEADER,
          TIMESTAMP_HEADER,
          NONCE_HEADER,
        ]);
        const body =
          request.body instanceof Readable
            ? {
                body: Readable.toWeb(request.body) as ReadableStream<Uint8Array>,
                duplex: "half" as const,
              }
            : {};
        try {
          const response = await fetch(upstream, {
            method: request.method,
            headers,
            ...body,
            redirect: "manual",
            dispatcher: getPinnedDispatcher(CONFIGURED_PREVIEW_POLICY),
            signal: AbortSignal.timeout(30_000),
          } as RequestInit & { duplex?: "half" });
          return relayFetchResponse(reply, request.method, response, null);
        } catch {
          request.raw.resume();
          return reply.badGateway("Configured preview destination is unreachable");
        }
      },
    );
  });
  app.get(
    "/internal/ws/configured-preview",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const error = configuredPreviewQueryError(request.query as { url?: string });
        if (error !== null) return reply.badRequest(error);
      },
    },
    (socket, request) =>
      acceptConfiguredPreviewStream(app, socket, request.query as { url: string }),
  );

  // The two-hop preview proxy's agent-side half (issue #28 phase 6): the
  // primary's own preview-proxy.ts forwards a browser's preview request
  // here instead of dialing a remote-hosted project's dev server directly
  // (which it has no network path to) — this agent dials it instead, on
  // its own loopback only (see resolveLoopbackPreviewUrl above). `*` is
  // Fastify's wildcard, always preceded by a literal "/" — safe because
  // the primary's own upstreamUrl.pathname (preview-proxy.ts's
  // buildUpstreamUrl) always starts with "/", so the request path here
  // always has one too, even for the dev server's own root ("/internal/
  // preview/5173/").
  //
  // Registered in its own encapsulated child context, not directly on
  // `app`, specifically so it can install a raw-passthrough content-type
  // parser without disturbing how any *other* /internal/* route (JSON
  // bodies, or the image/* parser above) parses its own body — a Fastify
  // child inherits its parent's hooks/decorators (including the bearer-
  // token onRequest check registered at the top of this function) but its
  // own addContentTypeParser calls stay scoped to itself. Removing every
  // inherited parser first, then adding a single "*" one, matters: adding
  // "*" alone would leave the inherited application/json parser still
  // winning for a JSON-Content-Type body, handing this handler an already-
  // parsed object it would have to lossily re-serialize rather than the
  // exact bytes the dev server needs.
  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", (_req, payload, done) => {
      done(null, payload);
    });

    scope.all<{ Params: { port: string } }>(
      "/internal/preview/:port/*",
      { ...INTERNAL_RATE_LIMIT, bodyLimit: MAX_PREVIEW_BODY_BYTES },
      async (request, reply) => {
        const port = parsePort(request.params.port);
        if (port === null) return reply.badRequest("port must be 1-65535");

        // request.raw.url, not Fastify's own decoded wildcard param: the
        // exact bytes the primary sent (including the query string, which a
        // wildcard route param wouldn't include) are what matter here, not
        // a re-encoded reconstruction of them.
        const prefix = `/internal/preview/${request.params.port}`;
        const rawUrl = request.raw.url ?? "/";
        const rest = rawUrl.startsWith(prefix) ? rawUrl.slice(prefix.length) : "/";

        const upstreamUrl = resolveLoopbackPreviewUrl(rest || "/", port);
        if (!upstreamUrl) return reply.badRequest("invalid preview path");

        // Strips the caller's own "authorization" header — the bearer token
        // this same request just authenticated with — before it reaches
        // arbitrary project dev-server code (see buildUpstreamRequestHeaders'
        // own comment on why this exclusion exists).
        // Over the outbound channel the replay also carries this agent's own
        // process-local token; it must not reach a dev server either.
        const headers = buildUpstreamRequestHeaders(request, upstreamUrl.host, [
          "authorization",
          AGENT_CHANNEL_AUTH_HEADER,
        ]);
        const body =
          request.body instanceof Readable
            ? {
                body: Readable.toWeb(request.body) as ReadableStream<Uint8Array>,
                duplex: "half" as const,
              }
            : {};

        let upstreamResponse: Response;
        try {
          upstreamResponse = await fetch(upstreamUrl, {
            method: request.method,
            headers,
            ...body,
            // Never auto-follow — forward the redirect to the primary (and,
            // from there, the browser) as-is, same posture as
            // preview-proxy.ts's own local-case fetch.
            redirect: "manual",
          } as RequestInit & { duplex?: "half" });
        } catch (err) {
          request.raw.resume();
          app.log.warn({ err, port }, "internal preview proxy: upstream unreachable");
          return reply.badGateway(`dev server on port ${port} is unreachable`);
        }
        // Never rewritten here — only the primary (preview-proxy.ts) knows
        // the browser's own URL space (including a devServerUrl's base-path
        // prefix); relativizing at this hop against this agent's loopback
        // origin instead would double up that prefix once the primary later
        // relativizes again. See http-proxy.ts's relativizeUpstreamLocation.
        return relayFetchResponse(reply, request.method, upstreamResponse, null);
      },
    );
  });

  // The WS analog of /internal/preview/:port/* above, for a remote-hosted
  // project's HMR connection (issue #28 phase 6) — port and the dev
  // server's own path+query travel as query params (a WS upgrade request
  // has no body), validated and resolved against this agent's own loopback
  // by the same resolveLoopbackPreviewUrl before the handshake completes.
  app.get(
    "/internal/ws/preview",
    {
      websocket: true,
      config: INTERNAL_RATE_LIMIT.config,
      preValidation: async (request, reply) => {
        const error = previewQueryError(request.query as Record<string, string | undefined>);
        if (error !== null) return reply.badRequest(error);
      },
    },
    (socket, req) =>
      acceptPreviewStream(app, socket, req.query as Record<string, string | undefined>),
  );

  registerBrowserRoutes(app, INTERNAL_RATE_LIMIT);

  // No project lookup here — dev-server-status is a live TCP/HTTP probe of
  // this agent's own loopback, not a DB read (this agent has no DB; see
  // src/app.ts's MULLION_ROLE === "agent" branch). The primary already holds
  // the project row and resolves devServerUrl into a port + scheme itself
  // (src/routes/projects.ts), forwarding only those — never the full URL or
  // host — same trust rule preview-proxy.ts's own remote dispatch follows
  // (src/db/schema.ts's projects table comment: "only the port is forwarded,
  // never the host"). A caller-supplied hostname here would turn this route
  // into a TCP-connect probe of arbitrary hosts reachable from the agent.
  app.get<{ Querystring: { port: string; scheme: string } }>(
    "/internal/dev-server-status",
    { ...INTERNAL_RATE_LIMIT },
    async (request, reply) => {
      const port = parsePort(request.query.port);
      if (port === null) return reply.badRequest("port must be 1-65535");
      const scheme = request.query.scheme;
      if (scheme !== "http" && scheme !== "https") {
        return reply.badRequest("scheme must be 'http' or 'https'");
      }

      const online = await pingDevServer(`${scheme}://127.0.0.1:${port}`);
      return { online };
    },
  );
}

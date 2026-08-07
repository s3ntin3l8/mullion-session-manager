import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { envPlugin } from "./plugins/env.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { dbPlugin } from "./plugins/db.js";
import { ptyPlugin } from "./plugins/pty.js";
import { browserPlugin } from "./plugins/browser.js";
import { hooksPlugin } from "./plugins/hooks.js";
import { controlSocketPlugin } from "./plugins/control-socket.js";
import { githubPRPollerPlugin } from "./plugins/github-pr-poller.js";
import { taskWatcherPlugin } from "./plugins/task-watcher.js";
import { webhookReconcilerPlugin } from "./plugins/webhook-reconciler.js";
import { gitFetcherPlugin } from "./plugins/git-fetcher.js";
import { hostHeartbeatPlugin } from "./plugins/host-heartbeat.js";
import { agentEnrollmentPlugin } from "./plugins/agent-enrollment.js";
import { requestNoncePlugin } from "./plugins/request-nonce.js";
import { eventStorePlugin } from "./plugins/event-store.js";
import { pushPlugin } from "./plugins/push.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { authPlugin } from "./plugins/auth.js";
import { isAuthEnabled } from "./services/auth.js";
import { isOidcConfigPartial, isOidcEnabled } from "./services/oidc.js";
import { staticPlugin } from "./plugins/static.js";
import { previewProxyPlugin } from "./plugins/preview-proxy.js";
import { rootRoute } from "./routes/root.js";
import { healthRoute } from "./routes/health.js";
import { authRoute } from "./routes/auth.js";
import { terminalRoute } from "./routes/terminal.js";
import { browserRoute } from "./routes/browser.js";
import { browserAutomationRoute } from "./routes/browser-automation.js";
import { eventsRoute } from "./routes/events.js";
import { projectsRoute } from "./routes/projects.js";
import { sessionsRoute } from "./routes/sessions.js";
import { workspacesRoute } from "./routes/workspaces.js";
import { groupsRoute } from "./routes/groups.js";
import { agentsRoute } from "./routes/agents.js";
import { actionsRoute } from "./routes/actions.js";
import { serverInfoRoute } from "./routes/server-info.js";
import { updatesRoute } from "./routes/updates.js";
import { settingsRoute } from "./routes/settings.js";
import { pushRoute } from "./routes/push.js";
import { internalRoutes } from "./routes/internal.js";
import { hostsRoute } from "./routes/hosts.js";
import { enrollmentRoute } from "./routes/enrollment.js";
import { integrationsRoute } from "./routes/integrations.js";
import { webhookRoutes } from "./routes/webhooks.js";
import { githubWSRoute } from "./routes/ws-github.js";
import { tasksWSRoute } from "./routes/ws-tasks.js";
import { previewsRoute } from "./routes/previews.js";
import { projectUrlsRoute } from "./routes/project-urls.js";
import { agentRulesRoute } from "./routes/agent-rules.js";
import { skillsRoute } from "./routes/skills.js";
import { browserCookiesRoute } from "./routes/browser-cookies.js";
import { browserUrlsRoute } from "./routes/browser-urls.js";
import { tasksRoute } from "./routes/tasks.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // envPlugin first: everything below (including this role branch) reads
  // app.config.
  await app.register(envPlugin);

  // Multi-host support (issue #26). "primary" (default) is today's full
  // single-process app, unchanged below. "agent" is a lightweight, DB-less
  // process that runs PtyManager on a remote host and exposes only a
  // token-gated internal API (routes/internal.ts) to a primary — see
  // .claude/plans for the design. This hard invariant matters regardless of
  // which auth mode below: an agent must never boot with no path to a
  // shared secret at all, since that would mean serving an unauthenticated
  // internal API the moment anything reaches it.
  //
  // Issue #245 / roadmap 7.1 relaxes this to an *either/or*: the original
  // manual MULLION_AGENT_TOKEN (today's Settings → Add host flow, checked
  // as an inbound bearer token by internal.ts), or MULLION_PRIMARY_URL +
  // MULLION_ENROLLMENT_TOKEN (agent-enrollment.ts's onReady hook uses these
  // to self-register with the primary and obtain a rotating session
  // credential instead — see MULLION_ENROLLMENT_TOKEN's own doc comment in
  // env.ts for why that's a distinct variable, never a reuse of
  // MULLION_AGENT_TOKEN). An enrolled agent legitimately boots with
  // MULLION_AGENT_TOKEN empty; what's never legitimate is neither path
  // configured at all.
  const hasManualToken = app.config.MULLION_AGENT_TOKEN.trim() !== "";
  const hasEnrollmentPath =
    app.config.MULLION_PRIMARY_URL.trim() !== "" &&
    app.config.MULLION_ENROLLMENT_TOKEN.trim() !== "";
  if (app.config.MULLION_ROLE === "agent" && !hasManualToken && !hasEnrollmentPath) {
    throw new Error(
      "MULLION_ROLE=agent requires either MULLION_AGENT_TOKEN, or both " +
        "MULLION_PRIMARY_URL and MULLION_ENROLLMENT_TOKEN, to be set — refusing to boot " +
        "an agent with no path to a shared secret at all (see issues #26 and #245).",
    );
  }

  // Optional in-process auth for the primary role (issue #19, src/plugins/auth.ts).
  // Either credential alone is a real invariant violation, not just a
  // misconfiguration to warn about and limp along with: without
  // MULLION_SESSION_SECRET, login would have nothing to sign a session
  // cookie with, so it would either crash on first login or (worse, if
  // implemented carelessly) issue an unsigned/forgeable one — silently
  // defeating the entire gate it's meant to add. Mirrors the agent-token
  // check just above; unlike the credentials themselves (which are
  // legitimately optional — both empty means "auth off"), this combination
  // is never intentional.
  if (
    app.config.MULLION_ROLE === "primary" &&
    app.config.MULLION_SESSION_SECRET.trim() === "" &&
    (app.config.MULLION_AUTH_TOKEN.trim() !== "" || isOidcEnabled(app.config))
  ) {
    throw new Error(
      "MULLION_AUTH_TOKEN or MULLION_OIDC_* is set but MULLION_SESSION_SECRET is " +
        "empty — refusing to boot with in-process auth half-configured (see issues " +
        "#19 and #30).",
    );
  }

  // A partial MULLION_OIDC_* set can't complete discovery or the code
  // exchange — refusing to boot beats failing confusingly on the first
  // login attempt (see isOidcConfigPartial's own doc comment).
  if (app.config.MULLION_ROLE === "primary" && isOidcConfigPartial(app.config)) {
    throw new Error(
      "MULLION_OIDC_* is partially configured — MULLION_OIDC_ISSUER, " +
        "MULLION_OIDC_CLIENT_ID, MULLION_OIDC_CLIENT_SECRET, and " +
        "MULLION_OIDC_REDIRECT_URI must all be set together, or all left empty " +
        "(see issue #30).",
    );
  }

  // Preview-host auth token (issue #383, src/plugins/preview-proxy.ts).
  // Gated on MULLION_ROLE === "primary" since previewProxyPlugin never
  // registers on the "agent" role branch below — an agent has nothing for
  // this flag to gate, so it shouldn't refuse to boot over it.
  if (app.config.MULLION_ROLE === "primary" && app.config.PREVIEW_AUTH_REQUIRED) {
    // The bootstrap-token mint route (POST /api/previews/:slug/token, see
    // routes/previews.ts) sits behind authPlugin's own onRequest gate — but
    // that gate installs no hook at all when in-process auth isn't
    // configured (its own early return in src/plugins/auth.ts). Without
    // this check, PREVIEW_AUTH_REQUIRED=true plus no MULLION_AUTH_TOKEN/
    // MULLION_OIDC_* would mean *anyone* who can reach the dashboard origin
    // can mint their own valid bootstrap token and walk straight through
    // the preview gate this flag exists to add — a strictly worse posture
    // than the flag being off, dressed up as a security feature.
    if (!isAuthEnabled(app.config)) {
      throw new Error(
        "PREVIEW_AUTH_REQUIRED is set but no in-process auth (MULLION_AUTH_TOKEN or " +
          "MULLION_OIDC_*) is configured — refusing to boot, since the bootstrap-token " +
          "mint route this flag depends on would otherwise be reachable with no " +
          "credential at all (see issue #383).",
      );
    }
    // Same invariant as the in-process auth check above, for the same
    // reason: without MULLION_SESSION_SECRET there's nothing to sign the
    // bootstrap token/preview cookie with, so this would either crash the
    // first time a preview is opened or (worse) mint an unsigned/forgeable
    // one.
    if (app.config.MULLION_SESSION_SECRET.trim() === "") {
      throw new Error(
        "PREVIEW_AUTH_REQUIRED is set but MULLION_SESSION_SECRET is empty — refusing " +
          "to boot with preview-host auth half-configured (see issue #383).",
      );
    }
  }

  await app.register(loggingPlugin);
  await app.register(sensible);
  await app.register(securityPlugin);

  if (app.config.MULLION_ROLE === "agent") {
    // No app.db/app.encryption on an agent — intent lives only on the
    // primary. dbPlugin, staticPlugin (there's no frontend to serve here),
    // and every DB-backed product route are deliberately skipped. ptyPlugin
    // still registers (an agent's whole job is running PtyManager locally),
    // but with no dbPlugin registered first, its reconciler gate (see
    // src/plugins/pty.ts) must never touch app.db. hooksPlugin registers
    // here too (issue #172): an agent spawns hook-emitting sessions exactly
    // like the primary does. hooksPlugin does read app.db now (issue #405's
    // agent-guide setting lookup), but only conditionally (`app.db ? ... :
    // DEFAULT_SETTINGS`) — it still has no hard role-specific gate, it just
    // falls back to defaults when there's no settings DB to read.
    await app.register(ptyPlugin);
    await app.register(browserPlugin);
    await app.register(hooksPlugin);
    await app.register(websocketPlugin);
    await app.register(healthRoute);
    // Before internalRoutes: decorates app.agentSession, which
    // internalRoutes' own onRequest gate additively checks alongside the
    // static MULLION_AGENT_TOKEN (issue #245 / roadmap 7.1). Inert
    // (registers no onReady/timer at all) unless both MULLION_PRIMARY_URL
    // and MULLION_ENROLLMENT_TOKEN are set — a manual-token-only agent is
    // completely unaffected.
    await app.register(agentEnrollmentPlugin);
    // Before internalRoutes: decorates app.requestNonceStore, which
    // internalRoutes' own onRequest/preValidation hooks use to reject a
    // replayed signed request (issue #249 / roadmap 7.5). Inert (no store,
    // no timer) on the primary role — it only ever signs outbound requests,
    // never verifies an inbound one.
    await app.register(requestNoncePlugin);
    await app.register(internalRoutes);
    return app;
  }

  // dbPlugin must register before ptyPlugin: ptyPlugin's reconciler reads
  // app.db (via getStoredSettings) as soon as it's registered.
  await app.register(dbPlugin);
  await app.register(ptyPlugin);
  // Must register after BOTH dbPlugin (needs app.db) and ptyPlugin (needs
  // app.pty.onEvent() to subscribe to) — same ordering logic as the
  // dbPlugin-before-ptyPlugin comment just above. See its own doc comment
  // for the primary-local-only scope and the agent-role no-op guard.
  await app.register(eventStorePlugin);
  // Same ordering requirement as eventStorePlugin just above (needs both
  // app.db and app.pty.onEvent) — see plugins/push.ts's own doc comment.
  await app.register(pushPlugin);
  // No ordering dependency on db/pty — registered here just to group
  // session/runtime-infra plugins together. See src/plugins/browser.ts;
  // stays inert (BrowserManager throws on every call) unless BROWSER_ENABLED.
  await app.register(browserPlugin);
  // hooksPlugin must register after ptyPlugin: it reads app.pty.hookSocketPath
  // and app.pty.resolveToken(), both only available once ptyPlugin has
  // decorated app.pty.
  await app.register(hooksPlugin);
  await app.register(githubPRPollerPlugin);
  await app.register(taskWatcherPlugin);
  await app.register(webhookReconcilerPlugin);
  await app.register(gitFetcherPlugin);
  await app.register(hostHeartbeatPlugin);
  await app.register(websocketPlugin);
  // authPlugin must register before previewProxyPlugin: both install a
  // global onRequest hook, and onRequest hooks run in registration order —
  // this is what lets authPlugin's hook reject an unauthenticated
  // preview-host HTTP request before previewProxyPlugin's own onRequest
  // hook gets a chance to proxy it. (Not before websocketPlugin for any
  // functional reason — see src/plugins/auth.ts's own comment on why it
  // doesn't gate the preview-host WS upgrade path at all.)
  await app.register(authPlugin);
  // previewProxyPlugin must register *after* websocketPlugin, not just
  // after dbPlugin (its other hard dependency, for app.db): it needs
  // @fastify/websocket's own 'upgrade' listener to already be attached to
  // app.server so it can capture and wrap it (see its own comment) — Node's
  // EventEmitter has no stopPropagation, so the only reliable way to make
  // sure a preview-host upgrade is handled by exactly one of "this plugin"
  // or "@fastify/websocket's normal routing" is to own the single
  // dispatcher and explicitly choose which one runs, rather than relying on
  // registration-order racing (an earlier version tried registering ahead
  // of websocketPlugin instead — this phase's own test suite caught the
  // result: both handlers wrote to the same socket, corrupting the
  // WebSocket frame stream).
  await app.register(previewProxyPlugin);
  await app.register(staticPlugin);

  await app.register(rootRoute);
  await app.register(healthRoute);
  await app.register(authRoute);
  await app.register(projectsRoute);
  await app.register(sessionsRoute);
  await app.register(workspacesRoute);
  await app.register(groupsRoute);
  await app.register(agentsRoute);
  await app.register(actionsRoute);
  await app.register(serverInfoRoute);
  await app.register(updatesRoute);
  await app.register(settingsRoute);
  await app.register(pushRoute);
  await app.register(hostsRoute);
  await app.register(enrollmentRoute);
  await app.register(integrationsRoute);
  await app.register(webhookRoutes);
  await app.register(previewsRoute);
  await app.register(projectUrlsRoute);
  await app.register(agentRulesRoute);
  await app.register(skillsRoute);
  await app.register(browserCookiesRoute);
  await app.register(browserUrlsRoute);
  await app.register(tasksRoute);
  await app.register(terminalRoute);
  await app.register(githubWSRoute);
  await app.register(tasksWSRoute);
  await app.register(browserRoute);
  await app.register(browserAutomationRoute);
  await app.register(eventsRoute);

  // Registered last: it dispatches by re-entering the routes above via
  // app.inject() (see its own doc comment), so it has no functional
  // ordering dependency on any of them — placed here only to keep this
  // meta/transport layer visually grouped after the full route surface it
  // sits on top of. Its one real dependency, app.pty.controlSocketPath, is
  // satisfied by ptyPlugin above; it no-ops for the "agent" role internally.
  await app.register(controlSocketPlugin);

  return app;
}

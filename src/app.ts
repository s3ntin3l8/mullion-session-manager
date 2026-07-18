import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { envPlugin } from "./plugins/env.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { dbPlugin } from "./plugins/db.js";
import { ptyPlugin } from "./plugins/pty.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { staticPlugin } from "./plugins/static.js";
import { previewProxyPlugin } from "./plugins/preview-proxy.js";
import { rootRoute } from "./routes/root.js";
import { healthRoute } from "./routes/health.js";
import { usersRoute } from "./routes/users.js";
import { terminalRoute } from "./routes/terminal.js";
import { projectsRoute } from "./routes/projects.js";
import { sessionsRoute } from "./routes/sessions.js";
import { workspacesRoute } from "./routes/workspaces.js";
import { groupsRoute } from "./routes/groups.js";
import { agentsRoute } from "./routes/agents.js";
import { actionsRoute } from "./routes/actions.js";
import { serverInfoRoute } from "./routes/server-info.js";
import { settingsRoute } from "./routes/settings.js";
import { internalRoutes } from "./routes/internal.js";
import { hostsRoute } from "./routes/hosts.js";
import { integrationsRoute } from "./routes/integrations.js";
import { previewsRoute } from "./routes/previews.js";

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
  // .claude/plans for the design. The primary side that actually calls this
  // API lands in a follow-up PR; this one hard invariant matters regardless:
  // an agent must never boot without a token, since that would mean serving
  // an unauthenticated internal API the moment anything reaches it.
  if (app.config.TESSERA_ROLE === "agent" && app.config.TESSERA_AGENT_TOKEN.trim() === "") {
    throw new Error(
      "TESSERA_ROLE=agent requires TESSERA_AGENT_TOKEN to be set — refusing to boot " +
        "an agent with no shared secret (see issue #26).",
    );
  }

  await app.register(loggingPlugin);
  await app.register(sensible);
  await app.register(securityPlugin);

  if (app.config.TESSERA_ROLE === "agent") {
    // No app.db/app.encryption on an agent — intent lives only on the
    // primary. dbPlugin, staticPlugin (there's no frontend to serve here),
    // and every DB-backed product route are deliberately skipped. ptyPlugin
    // still registers (an agent's whole job is running PtyManager locally),
    // but with no dbPlugin registered first, its reconciler gate (see
    // src/plugins/pty.ts) must never touch app.db.
    await app.register(ptyPlugin);
    await app.register(websocketPlugin);
    await app.register(healthRoute);
    await app.register(internalRoutes);
    return app;
  }

  // dbPlugin must register before ptyPlugin: ptyPlugin's reconciler reads
  // app.db (via getStoredSettings) as soon as it's registered.
  await app.register(dbPlugin);
  await app.register(ptyPlugin);
  await app.register(websocketPlugin);
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
  await app.register(usersRoute);
  await app.register(projectsRoute);
  await app.register(sessionsRoute);
  await app.register(workspacesRoute);
  await app.register(groupsRoute);
  await app.register(agentsRoute);
  await app.register(actionsRoute);
  await app.register(serverInfoRoute);
  await app.register(settingsRoute);
  await app.register(hostsRoute);
  await app.register(integrationsRoute);
  await app.register(previewsRoute);
  await app.register(terminalRoute);

  return app;
}

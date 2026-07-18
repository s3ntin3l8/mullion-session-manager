import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { envPlugin } from "./plugins/env.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { dbPlugin } from "./plugins/db.js";
import { ptyPlugin } from "./plugins/pty.js";
import { websocketPlugin } from "./plugins/websocket.js";
import { staticPlugin } from "./plugins/static.js";
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
  // process meant to run PtyManager on a remote host and expose only a
  // token-gated internal API to a primary — see .claude/plans for the design.
  // The internal API itself lands in a follow-up PR; this just reserves the
  // role split and its one hard invariant: an agent must never boot without
  // a token, since that would mean serving an unauthenticated internal API
  // the moment those routes exist.
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
    return app;
  }

  // dbPlugin must register before ptyPlugin: ptyPlugin's reconciler reads
  // app.db (via getStoredSettings) as soon as it's registered.
  await app.register(dbPlugin);
  await app.register(ptyPlugin);
  await app.register(websocketPlugin);
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
  await app.register(terminalRoute);

  return app;
}

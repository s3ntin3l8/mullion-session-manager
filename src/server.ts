import { buildApp } from "./app.js";
import { getCachedAgents } from "./services/agent-detect.js";

async function start() {
  const app = await buildApp();

  // Close the server (and DB via the onClose hook) on termination signals.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      app.log.info(`Received ${signal}, shutting down gracefully`);
      try {
        await app.close();
        process.exit(0);
      } catch (err) {
        app.log.error(err);
        process.exit(1);
      }
    });
  }

  try {
    const address = await app.listen({
      port: app.config.PORT,
      host: app.config.HOST,
    });
    app.log.info(`Server listening at ${address}`);
    // Warm the launcher/agent probe cache (login-shell `command -v` per
    // binary) so the first palette open doesn't pay for it. Fire-and-forget:
    // it must never delay or fail boot.
    getCachedAgents()
      .then((agents) => app.log.debug({ agents: agents.length }, "warmed agent probe cache"))
      .catch(() => {});
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

start();

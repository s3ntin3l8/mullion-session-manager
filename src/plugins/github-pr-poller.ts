import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { startGitHubPRPoller } from "../services/github-pr-poller.js";

export const githubPRPollerPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  let cleanup: (() => void) | null = null;

  app.addHook("onReady", () => {
    cleanup = startGitHubPRPoller(app);
  });

  app.addHook("onClose", () => {
    if (cleanup) cleanup();
  });
});

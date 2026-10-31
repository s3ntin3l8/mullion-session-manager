import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { refreshSessionGithubAuth } from "../services/session-github-auth.js";

// #2246 — re-sends a remote session's GitHub App token to its host before it
// expires (~1h). A tick only touches tokens within SESSION_TOKEN_RENEW_BEFORE_MS
// of expiry, so a short interval costs nothing between renewals.
export const SESSION_GITHUB_REFRESH_INTERVAL_MS = 60_000;

export const sessionGithubRefresherPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;
  const timer = setInterval(() => {
    refreshSessionGithubAuth(app).catch((err) => {
      app.log.error({ err }, "session GitHub token refresh failed");
    });
  }, SESSION_GITHUB_REFRESH_INTERVAL_MS);
  timer.unref();
  app.addHook("onClose", () => clearInterval(timer));
});

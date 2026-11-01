import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { setGitHubApiBase } from "../services/github-fetch.js";

// Applies MULLION_GITHUB_API_URL to the process-wide GitHub API base. Runs
// right after envPlugin so every later plugin and route sees it.
export const githubApiBasePlugin = fp(async (app: FastifyInstance) => {
  setGitHubApiBase(app.config.MULLION_GITHUB_API_URL);
});

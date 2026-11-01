import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { setGitHubApiBase } from "../services/github-fetch.js";

// Applies MULLION_GITHUB_API_URL to the process-wide GitHub API base. Runs
// right after envPlugin so every later plugin and route sees it. The base is
// the only writer of that host, so a typo (missing scheme, stray space) is
// rejected at boot rather than turning every GitHub call into "Could not
// reach GitHub".
export const githubApiBasePlugin = fp(async (app: FastifyInstance) => {
  const url = app.config.MULLION_GITHUB_API_URL.trim();
  if (url) {
    try {
      new URL(url);
    } catch {
      throw new Error(`MULLION_GITHUB_API_URL is not a valid URL: ${JSON.stringify(url)}`);
    }
  }
  setGitHubApiBase(url);
});

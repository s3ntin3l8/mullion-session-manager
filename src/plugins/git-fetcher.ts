import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { getStoredSettings } from "../services/settings.js";
import { runGitFetch } from "../services/git-fetch.js";

let fetchTimer: ReturnType<typeof setInterval> | undefined;
const lastFetchTimes: Map<string, number> = new Map();
const inFlight: Set<string> = new Set();

async function sweep(app: FastifyInstance) {
  const settings = getStoredSettings(app.db);
  const intervalSeconds = settings.sessions.gitAutoFetchIntervalSeconds;

  const projectRows = app.db
    .select()
    .from(projects)
    .where(sql`${projects.autoFetch} IS NOT false`)
    .all();

  for (const project of projectRows) {
    const shouldFetch =
      project.autoFetch === true || (project.autoFetch === null && intervalSeconds > 0);
    if (!shouldFetch) continue;

    const key = `${project.hostId}:${project.cwd}`;
    if (inFlight.has(key)) continue;

    inFlight.add(key);
    const fetch = (async () => {
      try {
        if (project.hostId === LOCAL_HOST_ID) {
          const result = await runGitFetch(project.cwd);
          if (!result.success) {
            app.log.warn(
              { projectId: project.id, hostId: project.hostId, error: result.error },
              "git fetch failed",
            );
          }
        } else {
          const client = getRemoteHostClient(app, project.hostId);
          await client.resolveGitFetch(project.cwd);
        }
        lastFetchTimes.set(key, Date.now());
      } catch (err) {
        app.log.warn({ err, projectId: project.id, hostId: project.hostId }, "git fetch failed");
      } finally {
        inFlight.delete(key);
      }
    })();
    void fetch;
  }
}

export const gitFetcherPlugin = fp(async (app: FastifyInstance) => {
  if (app.config.MULLION_ROLE !== "primary") return;

  function armTimer(intervalSeconds: number) {
    if (fetchTimer) clearInterval(fetchTimer);
    if (intervalSeconds <= 0) return;
    fetchTimer = setInterval(() => {
      sweep(app).catch((err) => {
        app.log.error({ err }, "git fetch sweep failed");
      });
    }, intervalSeconds * 1000);
    fetchTimer.unref();
  }

  app.decorate("reconfigureGitFetcher", (intervalSeconds: number) => {
    armTimer(intervalSeconds);
  });

  app.addHook("onReady", async () => {
    const settings = getStoredSettings(app.db);
    armTimer(settings.sessions.gitAutoFetchIntervalSeconds);
  });

  app.addHook("onClose", () => {
    if (fetchTimer) clearInterval(fetchTimer);
  });
});

declare module "fastify" {
  interface FastifyInstance {
    reconfigureGitFetcher: (intervalSeconds: number) => void;
  }
}

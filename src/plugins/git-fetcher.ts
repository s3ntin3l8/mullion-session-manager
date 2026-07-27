import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { projects } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient } from "../services/remote-host-client.js";
import { getStoredSettings } from "../services/settings.js";
import { gitEnv } from "../services/git-env.js";

const FETCH_TIMEOUT_MS = 30_000;

let fetchTimer: ReturnType<typeof setInterval> | undefined;
const lastFetchTimes: Map<string, number> = new Map();
const inFlight: Set<string> = new Set();

function spawnGitFetch(cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", cwd, "fetch", "origin", "--quiet", "--prune"], {
      env: gitEnv(),
      stdio: "ignore",
      timeout: FETCH_TIMEOUT_MS,
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git fetch exited with code ${code}`));
    });
    child.on("error", reject);
  });
}

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
          await spawnGitFetch(project.cwd);
        } else {
          const client = getRemoteHostClient(app, project.hostId);
          await client.resolveGitFetch(project.cwd);
        }
        lastFetchTimes.set(project.cwd, Date.now());
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
    fetchTimer = setInterval(() => void sweep(app), intervalSeconds * 1000);
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

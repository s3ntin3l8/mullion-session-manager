import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { projects } from "../db/schema.js";
import { sql } from "drizzle-orm";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostUnreachableError } from "../services/remote-host-client.js";
import { getStoredSettings } from "../services/settings.js";
import { runGitFetch } from "../services/git-fetch.js";
import { isCloneBusy, markCloneBusy, releaseClone } from "../services/git-clone-busy.js";
import { parseHostCwds } from "../services/placement.js";
import { parseHostCwdsMeta } from "../services/host-cwds-meta.js";
import { resolveRepoRef } from "../services/host-git.js";
import { resolveGitHubToken } from "../services/github-integration.js";

let fetchTimer: ReturnType<typeof setInterval> | undefined;

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

    // The clone is the resource, not the project — and the repair (issue
    // #1896) claims the same clone through the same registry, so a sweep
    // can never land inside a repair's fetch window.
    if (isCloneBusy(project.hostId, project.cwd)) {
      await fetchManagedCheckouts(app, project);
      continue;
    }

    markCloneBusy(project.hostId, project.cwd);
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
    } catch (err) {
      app.log.warn({ err, projectId: project.id, hostId: project.hostId }, "git fetch failed");
    } finally {
      releaseClone(project.hostId, project.cwd);
    }
    await fetchManagedCheckouts(app, project);
  }
}

/** Fetches the Mullion-managed checkouts of `project` on its OTHER hosts.
 * Only hostIds in `hostCwdsMeta.managed`: a user-mapped or auto-detected
 * entry is the user's own clone and is never touched. */
async function fetchManagedCheckouts(
  app: FastifyInstance,
  project: typeof projects.$inferSelect,
): Promise<void> {
  const managed = parseHostCwdsMeta(project.hostCwdsMeta).managed;
  if (managed.length === 0) return;
  const hostCwds = parseHostCwds(project.hostCwds);

  // Resolved lazily and once per project: a private repo needs the read token,
  // and it crosses only the signed channel to an agent.
  let token: string | undefined;
  let tokenResolved = false;
  const readToken = async () => {
    if (tokenResolved) return token;
    tokenResolved = true;
    try {
      const ref = await resolveRepoRef(app, project);
      token = ref ? ((await resolveGitHubToken(app, ref, "read")) ?? undefined) : undefined;
    } catch (err) {
      app.log.debug({ err, projectId: project.id }, "no read token for managed-checkout fetch");
    }
    return token;
  };

  for (const hostId of managed) {
    const cwd = hostCwds[hostId];
    if (!cwd || hostId === project.hostId) continue;
    if (hostId !== LOCAL_HOST_ID) {
      // An offline host is skipped quietly and retried on the next tick.
      if (app.hostHeartbeatTracker?.getHealth(hostId)?.status !== "online") {
        app.log.debug({ projectId: project.id, hostId }, "managed checkout host offline; skipping");
        continue;
      }
    }
    if (isCloneBusy(hostId, cwd)) continue;
    markCloneBusy(hostId, cwd);
    try {
      const t = await readToken();
      const result =
        hostId === LOCAL_HOST_ID
          ? await runGitFetch(cwd, t)
          : await getRemoteHostClient(app, hostId).resolveGitFetch(cwd, t);
      if (!result.success && !("skipped" in result && result.skipped)) {
        app.log.warn(
          { projectId: project.id, hostId, error: result.error },
          "git fetch failed (managed checkout)",
        );
      }
    } catch (err) {
      if (err instanceof HostUnreachableError) {
        app.log.debug({ projectId: project.id, hostId }, "managed checkout host unreachable");
      } else {
        app.log.warn({ err, projectId: project.id, hostId }, "git fetch failed (managed checkout)");
      }
    } finally {
      releaseClone(hostId, cwd);
    }
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

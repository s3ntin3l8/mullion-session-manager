import type { FastifyInstance } from "fastify";
import { spawn as spawnChild } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appVersion } from "./server-info.js";
import { checkForUpdate, UpdateCheckError } from "../services/update-checker.js";

// In-flight phases self-update.sh writes to $TESSERA_HOME/.update-status.json
// while an update is running — see scripts/self-update.sh's write_status().
const IN_FLIGHT_PHASES = new Set(["downloading", "installing", "verifying", "restarting"]);

interface UpdateStatus {
  phase: string;
  version?: string;
  updatedAt?: number;
  error?: string;
}

function statusFilePath(tesseraHome: string): string {
  return path.join(tesseraHome, ".update-status.json");
}

/** Best-effort read — a missing or unparseable status file just means "no
 * update has ever run here," not an error worth surfacing. */
function readStatus(tesseraHome: string): UpdateStatus {
  try {
    const raw = fs.readFileSync(statusFilePath(tesseraHome), "utf8");
    return JSON.parse(raw) as UpdateStatus;
  } catch {
    return { phase: "idle" };
  }
}

interface ApplyUpdateBody {
  version: string;
  assetUrl: string;
}

// version/assetUrl are exactly what the client already received from the
// most recent GET /api/updates/check — apply doesn't re-hit GitHub itself,
// both to avoid a second network round-trip and to avoid racing "latest
// changed between check and apply" (the client applies what it showed the
// user, not whatever happens to be newest a moment later).
const applyUpdateSchema = {
  body: {
    type: "object",
    required: ["version", "assetUrl"],
    additionalProperties: false,
    properties: {
      version: { type: "string", pattern: "^\\d+\\.\\d+\\.\\d+$" },
      // Restricted to github.com, not just "https://" — this URL is handed
      // straight to curl inside self-update.sh (running as this host user,
      // with `npm ci` and a systemd unit restart downstream of it), so
      // pinning it to GitHub's own release-asset host is cheap
      // defense-in-depth against a tampered/malicious body, even though a
      // dashboard user already has full host shell access via terminals in
      // this app's threat model.
      assetUrl: { type: "string", pattern: "^https://github\\.com/" },
    },
  },
};

export async function updatesRoute(app: FastifyInstance) {
  app.get("/api/updates/check", async (_request, reply) => {
    const repo = app.config.TESSERA_UPDATE_REPO;
    const applyAvailable = app.config.TESSERA_HOME.trim() !== "";
    try {
      return await checkForUpdate(repo, appVersion, applyAvailable);
    } catch (err) {
      if (!(err instanceof UpdateCheckError)) throw err;
      app.log.warn({ repo, statusCode: err.statusCode }, "update check unavailable");
      return reply.badGateway(`could not check for updates: ${err.message}`);
    }
  });

  app.get("/api/updates/status", async () => {
    const tesseraHome = app.config.TESSERA_HOME;
    if (tesseraHome.trim() === "") return { phase: "unavailable" };
    return readStatus(tesseraHome);
  });

  app.post<{ Body: ApplyUpdateBody }>(
    "/api/updates/apply",
    { schema: applyUpdateSchema },
    async (request, reply) => {
      const tesseraHome = app.config.TESSERA_HOME;
      if (tesseraHome.trim() === "") {
        return reply.badRequest(
          "TESSERA_HOME is not configured — this instance is not a versioned-release " +
            "install (see deploy/README.md), so there's no releases/ dir to install into " +
            "or `current` symlink to flip.",
        );
      }

      // Best-effort pre-check: self-update.sh also takes its own filesystem
      // lock (mkdir $TESSERA_HOME/.update.lock) as the real guard against
      // two concurrent applies racing each other — this check just avoids
      // spawning a doomed second process and gives the caller a clean 409
      // instead of a spawn that immediately fails.
      const current = readStatus(tesseraHome);
      if (IN_FLIGHT_PHASES.has(current.phase)) {
        return reply.conflict(`update already in progress (phase: ${current.phase})`);
      }

      const { version, assetUrl } = request.body;
      // Ships inside every release tarball — always invoke *this running
      // release's own* copy (current/scripts/self-update.sh), not some
      // other version's, so the update logic in flight matches the app
      // that decided to run it.
      const scriptPath = path.join(tesseraHome, "current", "scripts", "self-update.sh");
      if (!fs.existsSync(scriptPath)) {
        return reply.internalServerError(
          `self-update script not found at ${scriptPath} — this release may predate the ` +
            "auto-update feature",
        );
      }

      // Detached exactly like pty-manager.ts's bootstrapMaster spawns a
      // dtach master: a transient systemd --user scope, collected
      // automatically on exit, outside this process's own cgroup. Required
      // because the script's own last step restarts *this* process's
      // systemd unit — a plain child spawned from here would die with it.
      const unitName = `tessera-update-${version}`;
      const child = spawnChild(
        "systemd-run",
        [
          "--user",
          "--scope",
          "--collect",
          "-u",
          unitName,
          "--",
          scriptPath,
          version,
          assetUrl,
          tesseraHome,
          process.execPath,
        ],
        { cwd: tesseraHome, env: process.env, stdio: "ignore" },
      );
      child.on("error", (err) => {
        app.log.error({ err, unitName }, "failed to launch self-update.sh");
      });
      child.unref();

      reply.code(202);
      return { phase: "downloading", version };
    },
  );
}

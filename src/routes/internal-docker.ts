import type { FastifyInstance } from "fastify";
import path from "node:path";
import {
  getComposeServices,
  isDockerComposeAvailable,
  type ComposeService,
} from "../services/docker-service-detect.js";
import {
  checkComposeUpdate,
  runServiceLifecycleAction,
  willRecreateOnApply,
  type ServiceLifecycleAction,
} from "../services/docker-compose-actions.js";
import { detectDevServerPortForSessionIds } from "../services/dev-server-detect.js";
import { INTERNAL_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots } from "./internal-roots.js";

// Issue #3427 — Docker Compose discovery and dev-server port detection for a
// remote-hosted project, answered by the host that actually runs the
// containers and dev servers. Registered from `internalRoutes`, so behind its
// auth hook and shared rate limit.

/** The services whose working directory is `cwd` or inside it. */
function servicesUnder(all: ComposeService[], cwd: string): ComposeService[] {
  const root = path.resolve(cwd);
  return all.filter((svc) => {
    const dir = path.resolve(svc.workingDir);
    return dir === root || dir.startsWith(root + path.sep);
  });
}

const SESSION_ID_LIST = /^\d{1,12}(,\d{1,12}){0,99}$/;

export function registerDockerRoutes(app: FastifyInstance): void {
  // Read-only. `docker` missing degrades to no services (getComposeServices
  // never throws), so an agent without Docker answers an empty list.
  app.get<{ Querystring: { cwd?: string } }>(
    "/internal/docker-services",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const { cwd } = request.query;
      if (!cwd) return reply.badRequest("cwd query param is required");
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const services = servicesUnder(await getComposeServices(), resolvedCwd);
      return {
        services,
        composeAvailable: services.length > 0 ? await isDockerComposeAvailable() : false,
      };
    },
  );

  // MUTATING (restart/stop/start change containers; check-update pulls an
  // image), so it is on the mutation list in remote-host-errors.ts's test. The
  // service is re-resolved HERE from the agent's own discovery under `cwd`:
  // the primary names a service, it never supplies a docker argument, the same
  // authorization boundary routes/project-docker.ts's resolveOwnedService is.
  app.post<{
    Body: {
      cwd: string;
      composeProject: string;
      service: string;
      action: ServiceLifecycleAction | "check-update" | "will-recreate";
    };
  }>(
    "/internal/docker-compose-action",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        body: {
          type: "object",
          required: ["cwd", "composeProject", "service", "action"],
          additionalProperties: false,
          properties: {
            cwd: { type: "string", minLength: 1 },
            composeProject: { type: "string", minLength: 1, maxLength: 256 },
            service: { type: "string", minLength: 1, maxLength: 256 },
            action: {
              type: "string",
              enum: ["restart", "stop", "start", "check-update", "will-recreate"],
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { cwd, composeProject, service: serviceName, action } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      const service = servicesUnder(await getComposeServices(), resolvedCwd).find(
        (s) => s.composeProject === composeProject && s.service === serviceName,
      );
      if (!service) return reply.notFound("No such Compose service under this project");
      if (action === "check-update") return checkComposeUpdate(service);
      if (action === "will-recreate") return { willRecreate: await willRecreateOnApply(service) };
      return { success: await runServiceLifecycleAction(action, service) };
    },
  );

  // Read-only. The ids are the primary's session ids (the spawn carries them),
  // looked up in THIS agent's own PtyManager.
  app.get<{ Querystring: { sessionIds?: string } }>(
    "/internal/dev-server-port",
    INTERNAL_RATE_LIMIT,
    async (request, reply) => {
      const raw = request.query.sessionIds;
      if (raw === undefined || raw === "") return { port: null };
      if (!SESSION_ID_LIST.test(raw)) return reply.badRequest("sessionIds must be a comma list");
      return { port: detectDevServerPortForSessionIds(app, raw.split(",")) };
    },
  );
}

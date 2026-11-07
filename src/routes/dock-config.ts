// U4 — the write half of a project's dock config (see
// src/services/dock-config.ts's own header for the full rationale). A
// standalone route file rather than bolted onto routes/projects.ts's
// existing GET /api/projects/:id/dock: that route's own response is the
// MERGED view (global `<configDir>/dock.json` default + Docker-discovered
// monitors — see resolveProjectDock), which is the wrong shape for an
// editor to read back or write through (see dock-config.ts's readDockConfig
// doc comment). Kept as its own path, `/api/projects/:id/dock/config`,
// rather than overloading GET/PUT on the SAME `/api/projects/:id/dock`
// path with two different response shapes depending on verb — the
// precedent this repo actually follows for "its own small config surface"
// is agent-rules.ts being its own file (not bolted onto projects.ts either),
// which this mirrors.
//
// Every route here follows the exact hostId-branching triple every other
// project-scoped filesystem route in this repo uses (see agent-rules.ts's
// own file header, and projects.ts's /api/projects/:id/actions and
// .../dock): primary reads/writes locally, a remote-hosted project proxies
// through /internal/dock-config on that host — a project's `.crs/dock.json`
// is a property of whichever filesystem it lives on, so a remote-hosted
// project's config has to round-trip through that host, never the primary's.
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import {
  executionContextErrorStatus,
  resolveExecutionContext,
} from "../services/execution-context.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError, replyHostUnreachable } from "../services/host-error-reply.js";
import {
  readDockConfig,
  writeDockConfig,
  validateDockConfig,
  DockConfigValidationError,
  DockConfigTooLargeError,
  DockConfigSymlinkError,
  isTransientReadError,
  type DockConfigReadResult,
} from "../services/dock-config.js";

const DOCK_CONFIG_RATE_LIMIT = { config: { rateLimit: { max: 30, timeWindow: "1 minute" } } };

// Deliberately a THIN body schema — just enough for Fastify's own body
// parser to reject non-JSON and non-object-array shapes before the handler
// runs. Per-control field validation (required id/title/command, the
// height/env/worktreeRefresh types, and — critically — REJECTING an
// unknown field like `source`/`docker` rather than accepting it) is left
// entirely to dock-config.ts's validateDockConfig below, not expressed here
// too. Reason: Fastify's ajv-compiler defaults to `removeAdditional: true`
// (see @fastify/ajv-compiler's default-ajv-options.js) — an
// `additionalProperties: false` object schema under that default doesn't
// reject an unknown property, it silently STRIPS it before the handler ever
// sees it (confirmed empirically: a `source` field survived past a schema
// with `additionalProperties: false` and simply vanished from
// `request.body`, returning 200 instead of the intended 400). That's the
// opposite of the "tell the user about a typo, don't silently accept
// garbage" posture this write path needs, and per-route ajv customOptions
// aren't worth the complexity for one route. validateDockConfig runs against
// the still-untouched raw array below and is what actually enforces
// per-control shape — see its own doc comment.
const writeDockConfigSchema = {
  body: {
    type: "object",
    required: ["controls"],
    additionalProperties: false,
    properties: {
      controls: { type: "array", items: { type: "object" } },
    },
  },
};

export async function dockConfigRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  // Where the config lives: the project's own checkout by default, or — with
  // `?sessionId=` — the execution host and checkout of that session (issue
  // #2247). An unresolvable session is an error, never the project's host.
  async function resolveTarget(
    project: NonNullable<ReturnType<typeof getProjectOr404>>,
    sessionIdParam: string | undefined,
  ): Promise<
    { ok: true; hostId: string; cwd: string } | { ok: false; status: number; message: string }
  > {
    if (sessionIdParam === undefined) return { ok: true, hostId: project.hostId, cwd: project.cwd };
    const sessionId = Number(sessionIdParam);
    if (!Number.isInteger(sessionId))
      return { ok: false, status: 400, message: "Invalid session id" };
    const resolved = await resolveExecutionContext(
      app,
      { projectId: project.id, sessionId },
      { trustSessionCwd: true },
    );
    if (!resolved.ok) {
      return {
        ok: false,
        status: executionContextErrorStatus(resolved.error.code),
        message: resolved.error.message,
      };
    }
    // The config is the checkout's, not a subdirectory's.
    return { ok: true, hostId: resolved.context.hostId, cwd: resolved.context.checkoutRoot };
  }

  // GET /api/projects/:id/dock/config — the raw, per-project
  // `.crs/dock.json` (unmerged — see this file's own header). 200 even for
  // a malformed on-disk file (readDockConfig's `invalid`/`reason`); 503 is
  // reserved for a genuine transient read failure (permission denied) or an
  // unreachable remote host.
  app.get<{ Params: { id: string }; Querystring: { sessionId?: string } }>(
    "/api/projects/:id/dock/config",
    DOCK_CONFIG_RATE_LIMIT,
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();
      const target = await resolveTarget(project, request.query.sessionId);
      if (!target.ok)
        return reply
          .code(target.status)
          .send({ statusCode: target.status, message: target.message });

      if (target.hostId === LOCAL_HOST_ID) {
        try {
          return readDockConfig(target.cwd);
        } catch (err) {
          // Unreachable via any current call site (target.cwd is always
          // path.resolve()d at write time — see resolveDockConfigPath's own
          // comment), kept for the same reason the PUT branch below maps it
          // too: a clean 400 rather than a raw 500 if that upstream
          // guarantee is ever violated.
          if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
          if (isTransientReadError(err)) {
            app.log.warn({ projectId, err }, "dock config read permission denied");
            return reply.serviceUnavailable("Permission denied reading dock.json");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, target.hostId).resolveDockConfig(target.cwd);
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn({ hostId: target.hostId, err }, "host unreachable, dock config unavailable");
        return reply.serviceUnavailable(`Host ${target.hostId} is unreachable`);
      }
    },
  );

  // PUT /api/projects/:id/dock/config — replaces the project's own
  // `.crs/dock.json` wholesale (not a per-control patch — the editor always
  // sends the full, already-merged-client-side list of project-scope
  // controls, same "whole document" contract agent-rules.ts's PUT has for a
  // single target's content).
  app.put<{
    Params: { id: string };
    Querystring: { sessionId?: string };
    Body: { controls: unknown[] };
  }>(
    "/api/projects/:id/dock/config",
    { ...DOCK_CONFIG_RATE_LIMIT, schema: writeDockConfigSchema },
    async (request, reply) => {
      const projectId = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(projectId);
      if (!project) return reply.notFound();
      const target = await resolveTarget(project, request.query.sessionId);
      if (!target.ok)
        return reply
          .code(target.status)
          .send({ statusCode: target.status, message: target.message });

      let controls;
      try {
        controls = validateDockConfig({ controls: request.body.controls });
      } catch (err) {
        if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
        throw err;
      }

      if (target.hostId === LOCAL_HOST_ID) {
        try {
          writeDockConfig(target.cwd, controls);
          const result: DockConfigReadResult = readDockConfig(target.cwd);
          return result;
        } catch (err) {
          if (err instanceof DockConfigTooLargeError) return reply.badRequest(err.message);
          if (err instanceof DockConfigSymlinkError) return reply.badRequest(err.message);
          if (err instanceof DockConfigValidationError) return reply.badRequest(err.message);
          if (isTransientReadError(err)) {
            return reply.serviceUnavailable("Permission denied writing dock.json");
          }
          throw err;
        }
      }
      try {
        return await getRemoteHostClient(app, target.hostId).writeDockConfig(target.cwd, controls);
      } catch (err) {
        if (err instanceof HostRequestError) return forwardHostRequestError(reply, err);
        app.log.warn(
          { hostId: target.hostId, err },
          "host unreachable, could not write dock config",
        );
        return replyHostUnreachable(reply, target.hostId, err, "writing the dock config");
      }
    },
  );
}

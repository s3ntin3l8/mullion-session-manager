// Project file editor — list a project directory, read one text file, write
// one text file. Follows routes/agent-rules.ts's hostId-branching shape: a
// LOCAL_HOST_ID project is served straight off the primary's filesystem
// (services/project-files.ts), a remote-hosted one proxies through
// /internal/project-files/* on that host. Contents are secrets-adjacent
// (.env) — nothing here logs a request body or a file's content.
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError } from "../services/host-error-reply.js";
import {
  PROJECT_FILE_BODY_LIMIT,
  ProjectFileError,
  listProjectDir,
  readProjectFile,
  writeProjectFile,
} from "../services/project-files.js";

const FILES_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
};

const pathQuery = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string" } },
};

const writeSchema = {
  params: idParams,
  body: {
    type: "object",
    required: ["path", "content"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      expectedMtimeMs: { type: "number" },
      create: { type: "boolean" },
    },
  },
};

export async function projectFilesRoute(app: FastifyInstance) {
  function getProjectOr404(projectId: number) {
    const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
    return project ?? null;
  }

  function localErrorReply(reply: FastifyReply, err: unknown) {
    if (err instanceof ProjectFileError)
      return reply.code(err.httpStatus).send({ message: err.message, code: err.code });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM") {
      return reply.serviceUnavailable("Permission denied accessing the file");
    }
    throw err;
  }

  function remoteErrorReply(reply: FastifyReply, hostId: string, err: unknown) {
    if (err instanceof HostRequestError) {
      // The agent replies to a ProjectFileError with a structured `code`.
      // A coded error is forwarded WITH its code (the panel keys off it); a
      // 404 WITHOUT one is an older agent that doesn't have
      // /internal/project-files/* at all -> 501. 401/403 stay folded into
      // 503 by forwardHostRequestError (a host token problem, not this edit).
      let parsed: { code?: unknown; message?: unknown } = {};
      try {
        parsed = JSON.parse(err.body) as typeof parsed;
      } catch {
        // non-JSON body — no code
      }
      const code = typeof parsed?.code === "string" ? parsed.code : undefined;
      if (err.statusCode === 404 && !code) {
        return reply
          .code(501)
          .send({ message: "This host's Mullion is too old for file editing — upgrade it" });
      }
      if (code && err.statusCode !== 401 && err.statusCode !== 403) {
        const message = typeof parsed.message === "string" ? parsed.message : err.message;
        return reply.code(err.statusCode).send({ message, code });
      }
      return forwardHostRequestError(reply, err);
    }
    app.log.warn({ hostId, err }, "host unreachable, project files unavailable");
    return reply.serviceUnavailable(`Host ${hostId} is unreachable`);
  }

  function resolveProject(id: string, reply: FastifyReply) {
    const projectId = Number(id);
    if (!Number.isInteger(projectId)) {
      reply.badRequest("Invalid project id");
      return null;
    }
    const project = getProjectOr404(projectId);
    if (!project) {
      reply.notFound();
      return null;
    }
    return project;
  }

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/files",
    { ...FILES_RATE_LIMIT, schema: { params: idParams, querystring: pathQuery } },
    async (request, reply) => {
      const project = resolveProject(request.params.id, reply);
      if (!project) return;
      const relPath = request.query.path ?? "";
      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return listProjectDir(project.cwd, relPath);
        } catch (err) {
          return localErrorReply(reply, err);
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).listProjectDir(project.cwd, relPath);
      } catch (err) {
        return remoteErrorReply(reply, project.hostId, err);
      }
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string } }>(
    "/api/projects/:id/file",
    { ...FILES_RATE_LIMIT, schema: { params: idParams, querystring: pathQuery } },
    async (request, reply) => {
      const project = resolveProject(request.params.id, reply);
      if (!project) return;
      const relPath = request.query.path;
      if (!relPath) return reply.badRequest("path is required");
      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return readProjectFile(project.cwd, relPath);
        } catch (err) {
          return localErrorReply(reply, err);
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).readProjectFile(project.cwd, relPath);
      } catch (err) {
        return remoteErrorReply(reply, project.hostId, err);
      }
    },
  );

  app.put<{
    Params: { id: string };
    Body: { path: string; content: string; expectedMtimeMs?: number; create?: boolean };
  }>(
    "/api/projects/:id/file",
    { ...FILES_RATE_LIMIT, schema: writeSchema, bodyLimit: PROJECT_FILE_BODY_LIMIT },
    async (request, reply) => {
      const project = resolveProject(request.params.id, reply);
      if (!project) return;
      const { path: relPath, content, expectedMtimeMs, create } = request.body;
      if (project.hostId === LOCAL_HOST_ID) {
        try {
          return writeProjectFile(project.cwd, relPath, content, { expectedMtimeMs, create });
        } catch (err) {
          return localErrorReply(reply, err);
        }
      }
      try {
        return await getRemoteHostClient(app, project.hostId).writeProjectFile(
          project.cwd,
          relPath,
          content,
          { expectedMtimeMs, create },
        );
      } catch (err) {
        return remoteErrorReply(reply, project.hostId, err);
      }
    },
  );
}

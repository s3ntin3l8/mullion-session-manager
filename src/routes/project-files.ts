// Project file editor — list a project directory, read one text file, write
// one text file. Follows routes/agent-rules.ts's hostId-branching shape: a
// LOCAL_HOST_ID project is served straight off the primary's filesystem
// (services/project-files.ts), a remote-hosted one proxies through
// /internal/project-files/* on that host. Contents are secrets-adjacent
// (.env) — nothing here logs a request body or a file's content.
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { projects, sessions } from "../db/schema.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";
import { getRemoteHostClient, HostRequestError } from "../services/remote-host-client.js";
import { forwardHostRequestError } from "../services/host-error-reply.js";
import {
  PROJECT_FILE_BODY_LIMIT,
  ProjectFileError,
  listProjectDir,
  readProjectFile,
  writeProjectFile,
  makeProjectDir,
  deleteProjectPath,
  renameProjectPath,
  searchProjectFiles,
} from "../services/project-files.js";

const FILES_RATE_LIMIT = { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } };

const idParams = {
  type: "object",
  required: ["id"],
  properties: { id: { type: "string" } },
};

// `sessionId` (optional on every route below) re-roots the editor at that
// session's own cwd instead of the project's — a worktree session's
// gitignored .env lives in its worktree, which a custom worktree baseDir can
// put outside the project root. createSessionRecord only ever stores a cwd
// that is inside the project or a registered git worktree of its repo, so the
// session row is a sound source for it; a session of ANOTHER project is
// refused.
const pathQuery = {
  type: "object",
  additionalProperties: false,
  properties: { path: { type: "string" }, sessionId: { type: "string" } },
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
      sessionId: { type: "integer" },
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

  interface Ctx {
    hostId: string;
    /** Absolute root this request operates in (project cwd, or a session's). */
    cwd: string;
  }

  // Resolves the project (and, when `sessionId` is given, that session's cwd)
  // or sends the 400/404 itself and returns null.
  function resolveCtx(id: string, sessionIdRaw: unknown, reply: FastifyReply): Ctx | null {
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
    if (sessionIdRaw === undefined || sessionIdRaw === null || sessionIdRaw === "") {
      return { hostId: project.hostId, cwd: project.cwd };
    }
    const sessionId = Number(sessionIdRaw);
    if (!Number.isInteger(sessionId)) {
      reply.badRequest("Invalid session id");
      return null;
    }
    const [session] = app.db.select().from(sessions).where(eq(sessions.id, sessionId)).all();
    if (!session || session.projectId !== project.id) {
      reply.notFound("Session not found in this project");
      return null;
    }
    return { hostId: project.hostId, cwd: session.cwd ?? project.cwd };
  }

  // The hostId-branching every route shares: run `local` against the
  // primary's filesystem, or `remote` against the project's host.
  async function dispatch<T>(
    reply: FastifyReply,
    ctx: Ctx,
    local: (cwd: string) => T | Promise<T>,
    remote: (client: ReturnType<typeof getRemoteHostClient>, cwd: string) => Promise<T>,
  ) {
    if (ctx.hostId === LOCAL_HOST_ID) {
      try {
        return await local(ctx.cwd);
      } catch (err) {
        return localErrorReply(reply, err);
      }
    }
    try {
      return await remote(getRemoteHostClient(app, ctx.hostId), ctx.cwd);
    } catch (err) {
      return remoteErrorReply(reply, ctx.hostId, err);
    }
  }

  app.get<{ Params: { id: string }; Querystring: { path?: string; sessionId?: string } }>(
    "/api/projects/:id/files",
    { ...FILES_RATE_LIMIT, schema: { params: idParams, querystring: pathQuery } },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.query.sessionId, reply);
      if (!ctx) return;
      const relPath = request.query.path ?? "";
      return dispatch(
        reply,
        ctx,
        (cwd) => listProjectDir(cwd, relPath),
        (client, cwd) => client.listProjectDir(cwd, relPath),
      );
    },
  );

  app.get<{ Params: { id: string }; Querystring: { path?: string; sessionId?: string } }>(
    "/api/projects/:id/file",
    { ...FILES_RATE_LIMIT, schema: { params: idParams, querystring: pathQuery } },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.query.sessionId, reply);
      if (!ctx) return;
      const relPath = request.query.path;
      if (!relPath) return reply.badRequest("path is required");
      return dispatch(
        reply,
        ctx,
        (cwd) => readProjectFile(cwd, relPath),
        (client, cwd) => client.readProjectFile(cwd, relPath),
      );
    },
  );

  app.put<{
    Params: { id: string };
    Body: {
      path: string;
      content: string;
      expectedMtimeMs?: number;
      create?: boolean;
      sessionId?: number;
    };
  }>(
    "/api/projects/:id/file",
    { ...FILES_RATE_LIMIT, schema: writeSchema, bodyLimit: PROJECT_FILE_BODY_LIMIT },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.body.sessionId, reply);
      if (!ctx) return;
      const { path: relPath, content, expectedMtimeMs, create } = request.body;
      return dispatch(
        reply,
        ctx,
        (cwd) => writeProjectFile(cwd, relPath, content, { expectedMtimeMs, create }),
        (client, cwd) =>
          client.writeProjectFile(cwd, relPath, content, { expectedMtimeMs, create }),
      );
    },
  );

  const mkdirSchema = {
    params: idParams,
    body: {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: { path: { type: "string" }, sessionId: { type: "integer" } },
    },
  };

  app.post<{ Params: { id: string }; Body: { path: string; sessionId?: number } }>(
    "/api/projects/:id/files/mkdir",
    { ...FILES_RATE_LIMIT, schema: mkdirSchema },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.body.sessionId, reply);
      if (!ctx) return;
      const relPath = request.body.path;
      return dispatch(
        reply,
        ctx,
        (cwd) => makeProjectDir(cwd, relPath),
        (client, cwd) => client.makeProjectDir(cwd, relPath),
      );
    },
  );

  app.post<{
    Params: { id: string };
    Body: { from: string; to: string; sessionId?: number };
  }>(
    "/api/projects/:id/files/rename",
    {
      ...FILES_RATE_LIMIT,
      schema: {
        params: idParams,
        body: {
          type: "object",
          required: ["from", "to"],
          additionalProperties: false,
          properties: {
            from: { type: "string" },
            to: { type: "string" },
            sessionId: { type: "integer" },
          },
        },
      },
    },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.body.sessionId, reply);
      if (!ctx) return;
      const { from, to } = request.body;
      return dispatch(
        reply,
        ctx,
        (cwd) => renameProjectPath(cwd, from, to),
        (client, cwd) => client.renameProjectPath(cwd, from, to),
      );
    },
  );

  // DELETE with the path in the query (a DELETE body is unreliable through
  // proxies). Removes a file, a symlink (the link itself), or an EMPTY folder.
  app.delete<{ Params: { id: string }; Querystring: { path?: string; sessionId?: string } }>(
    "/api/projects/:id/file",
    { ...FILES_RATE_LIMIT, schema: { params: idParams, querystring: pathQuery } },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.query.sessionId, reply);
      if (!ctx) return;
      const relPath = request.query.path;
      if (!relPath) return reply.badRequest("path is required");
      return dispatch(
        reply,
        ctx,
        (cwd) => deleteProjectPath(cwd, relPath),
        (client, cwd) => client.deleteProjectPath(cwd, relPath),
      );
    },
  );

  // Filename search is fired as the user types (debounced client-side), so it
  // gets a higher ceiling than the other file routes.
  const SEARCH_RATE_LIMIT = { config: { rateLimit: { max: 240, timeWindow: "1 minute" } } };

  app.get<{ Params: { id: string }; Querystring: { q?: string; sessionId?: string } }>(
    "/api/projects/:id/files/search",
    {
      ...SEARCH_RATE_LIMIT,
      schema: {
        params: idParams,
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { q: { type: "string", maxLength: 200 }, sessionId: { type: "string" } },
        },
      },
    },
    async (request, reply) => {
      const ctx = resolveCtx(request.params.id, request.query.sessionId, reply);
      if (!ctx) return;
      const q = request.query.q ?? "";
      return dispatch(
        reply,
        ctx,
        (cwd) => searchProjectFiles(cwd, q),
        (client, cwd) => client.searchProjectFiles(cwd, q),
      );
    },
  );
}

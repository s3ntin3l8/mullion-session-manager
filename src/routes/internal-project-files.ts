import type { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import type { Readable } from "node:stream";
import { readFilesLocally, writeEntriesLocally } from "../services/host-files.js";
import { discoverCommittedScaffold } from "../services/session-lifecycle.js";
import { PathEscapeError } from "../services/safe-path.js";
import {
  PROJECT_FILE_BODY_LIMIT,
  ProjectFileError,
  listProjectDir,
  readProjectFile,
  statProjectFile,
  writeProjectFile,
  makeProjectDir,
  deleteProjectPath,
  renameProjectPath,
  searchProjectFiles,
  openProjectFileReadStream,
  writeProjectFileFromStream,
} from "../services/project-files.js";
import { FILE_STREAM_CONTENT_TYPE } from "../shared/constants.js";
import {
  readFilesSchema,
  writeFilesSchema,
  scaffoldScanSchema,
  projectFilesListSchema,
  projectFilesPathSchema,
  projectFilesSearchSchema,
  projectFilesRenameSchema,
  projectFilesReadSchema,
  projectFilesWriteSchema,
} from "./internal-schemas.js";
import type {
  ReadFilesBody,
  WriteFilesBody,
  ProjectFilesListBody,
  ProjectFilesReadBody,
  ProjectFilesWriteBody,
  ProjectFilesPathBody,
  ProjectFilesSearchBody,
  ProjectFilesRenameBody,
  ScaffoldScanBody,
} from "./internal-schemas.js";
import { INTERNAL_RATE_LIMIT } from "./internal-rate-limits.js";
import { requireWithinRoots } from "./internal-roots.js";

/**
 * The agent's read-files, write-files, project-files and scaffold-scan routes. Registered from `internalRoutes` so they sit
 * behind its auth hook and share its rate limits.
 */
export function registerProjectFilesRoutes(app: FastifyInstance): void {
  // Issue #895 — reads `paths`' current content directly off this agent's
  // own filesystem, for a remote-hosted project's scaffold preview/apply
  // (routes/project-setup.ts's readHostFiles, via
  // RemoteHostClient.readFiles). Delegates to the SAME readFilesLocally
  // (host-files.ts) the LOCAL_HOST_ID caller uses directly — see that
  // function's own doc comment for the EISDIR-as-empty-string sentinel and
  // "missing key = doesn't exist yet" conventions this preserves over the
  // wire unchanged. `cwd` gets this file's usual PROJECTS_ROOTS containment;
  // each individual path in `paths` gets its OWN containment check inside
  // readFilesLocally (resolveWithin, safe-path.ts) — a PathEscapeError there
  // means a caller asked for a path outside `cwd` itself, which is a
  // malformed request (400), not a filesystem error.
  app.post<{ Body: ReadFilesBody }>(
    "/internal/read-files",
    { ...INTERNAL_RATE_LIMIT, schema: readFilesSchema },
    async (request, reply) => {
      const { cwd, paths } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return { files: readFilesLocally(resolvedCwd, paths) };
      } catch (err) {
        if (err instanceof PathEscapeError) return reply.badRequest(err.message);
        throw err;
      }
    },
  );

  // Issue #895 — writes `entries` (files and/or symlinks) directly onto
  // this agent's own filesystem, optionally staging every change afterward
  // (`stage`, `git add -A`) — the agent-side counterpart of writeHostFiles
  // (host-files.ts), for a remote-hosted project's scaffold preview/apply.
  // Delegates to the SAME writeEntriesLocally the LOCAL_HOST_ID caller uses
  // directly; see that function's own doc comment for why BOTH ScaffoldEntry
  // variants (file and symlink) are handled identically here, not rejected
  // or no-op'd for a remote host. Each entry's `kind`-specific required
  // field (`contents` for "file", `target` for "symlink") is checked here
  // rather than in the JSON Schema (kept deliberately loose — see
  // internal-schemas.ts's own comment on `entries`) since ajv has no clean
  // way to express "required field depends on a sibling's value" without a
  // verbose `if`/`then` per branch.
  app.post<{ Body: WriteFilesBody }>(
    "/internal/write-files",
    { ...INTERNAL_RATE_LIMIT, schema: writeFilesSchema },
    async (request, reply) => {
      const { cwd, entries, stage } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      for (const entry of entries) {
        if (entry.kind === "file" && typeof entry.contents !== "string") {
          return reply.badRequest(`entry "${entry.path}" has kind "file" but no contents`);
        }
        if (entry.kind === "symlink" && typeof entry.target !== "string") {
          return reply.badRequest(`entry "${entry.path}" has kind "symlink" but no target`);
        }
      }
      try {
        const written = writeEntriesLocally(
          resolvedCwd,
          entries as Array<
            | { path: string; kind: "file"; contents: string }
            | { path: string; kind: "symlink"; target: string }
          >,
          { stage },
        );
        return { ok: true, ignored: written.ignored };
      } catch (err) {
        if (err instanceof PathEscapeError) return reply.badRequest(err.message);
        throw err;
      }
    },
  );

  // Project file editor — the agent-side half of routes/project-files.ts.
  // `cwd` gets this file's usual PROJECTS_ROOTS containment; the per-file
  // path is contained inside `cwd` by project-files.ts itself (lexical +
  // realpath). A ProjectFileError is replied with its structured `code` in
  // the body so the primary can tell a genuinely missing FILE (404 +
  // code:"not_found") from an older agent that lacks these routes entirely
  // (bare 404, no code).
  function replyProjectFileError(reply: FastifyReply, err: unknown) {
    if (err instanceof ProjectFileError) {
      return reply
        .code(err.httpStatus)
        .send({ statusCode: err.httpStatus, message: err.message, code: err.code });
    }
    throw err;
  }

  app.post<{ Body: ProjectFilesListBody }>(
    "/internal/project-files/list",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesListSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return listProjectDir(resolvedCwd, request.body.path ?? "");
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesReadBody }>(
    "/internal/project-files/read",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesReadSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return readProjectFile(resolvedCwd, request.body.path);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesReadBody }>(
    "/internal/project-files/stat",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesReadSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return statProjectFile(resolvedCwd, request.body.path);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesWriteBody }>(
    "/internal/project-files/write",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: projectFilesWriteSchema,
      bodyLimit: PROJECT_FILE_BODY_LIMIT,
    },
    async (request, reply) => {
      const { cwd, path: relPath, content, expectedMtimeMs, create } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return writeProjectFile(resolvedCwd, relPath, content, { expectedMtimeMs, create });
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesPathBody }>(
    "/internal/project-files/mkdir",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesPathSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return makeProjectDir(resolvedCwd, request.body.path);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesPathBody }>(
    "/internal/project-files/delete",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesPathSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return deleteProjectPath(resolvedCwd, request.body.path);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesRenameBody }>(
    "/internal/project-files/rename",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesRenameSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return renameProjectPath(resolvedCwd, request.body.from, request.body.to);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  // Streamed counterparts of the editor's read/write (the file browser's
  // upload/download). The body of an upload is the raw file under its own
  // content type — /internal/uploads below already owns application/octet-
  // stream in this plugin context, and buffers it. The path is exempt from
  // body hashing (request-signature.ts), so the byte count is enforced while
  // writing, not trusted from a header.
  app.addContentTypeParser(FILE_STREAM_CONTENT_TYPE, (_req, payload, done) => {
    done(null, payload);
  });

  app.post<{ Querystring: { cwd?: string; path?: string; mkdirs?: string } }>(
    "/internal/project-files/upload",
    {
      ...INTERNAL_RATE_LIMIT,
      schema: {
        querystring: {
          type: "object",
          required: ["cwd", "path"],
          additionalProperties: false,
          properties: {
            cwd: { type: "string", minLength: 1, maxLength: 4096 },
            path: { type: "string", minLength: 1, maxLength: 4096 },
            mkdirs: { type: "string", enum: ["1"] },
          },
        },
      },
    },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.query.cwd as string, "cwd");
      if (resolvedCwd === null) return;
      const body = request.body as Readable | undefined;
      if (!body || typeof body.pipe !== "function") {
        return reply.badRequest("expected a raw file body");
      }
      try {
        return await writeProjectFileFromStream(resolvedCwd, request.query.path as string, body, {
          maxBytes: app.config.FILE_TRANSFER_MAX_BYTES,
          mkdirs: request.query.mkdirs === "1",
        });
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesPathBody }>(
    "/internal/project-files/download",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesPathSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        const dl = openProjectFileReadStream(
          resolvedCwd,
          request.body.path,
          app.config.FILE_TRANSFER_MAX_BYTES,
        );
        return reply
          .header("content-type", "application/octet-stream")
          .header("content-length", String(dl.size))
          .send(dl.stream);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  app.post<{ Body: ProjectFilesSearchBody }>(
    "/internal/project-files/search",
    { ...INTERNAL_RATE_LIMIT, schema: projectFilesSearchSchema },
    async (request, reply) => {
      const resolvedCwd = requireWithinRoots(app, reply, request.body.cwd, "cwd");
      if (resolvedCwd === null) return;
      try {
        return await searchProjectFiles(resolvedCwd, request.body.query);
      } catch (err) {
        return replyProjectFileError(reply, err);
      }
    },
  );

  // Issue #1124 — reports whether a Mullion scaffold is actually committed
  // under `cwd` on THIS agent's own filesystem — the agent-side counterpart
  // of session-lifecycle.ts's discoverCommittedScaffoldOnHost, for a
  // remote-hosted project's committed-scaffold gate (createSessionRecord).
  // Deliberately NOT a general directory-listing primitive: it calls the
  // exact SAME discoverCommittedScaffold the LOCAL_HOST_ID caller uses
  // directly, so the two can never independently drift — see that
  // function's own doc comment for the two-pass identity/shape scan this
  // runs.
  app.post<{ Body: ScaffoldScanBody }>(
    "/internal/scaffold-scan",
    { ...INTERNAL_RATE_LIMIT, schema: scaffoldScanSchema },
    async (request, reply) => {
      const { cwd } = request.body;
      const resolvedCwd = requireWithinRoots(app, reply, cwd, "cwd");
      if (resolvedCwd === null) return;
      return discoverCommittedScaffold(resolvedCwd);
    },
  );
}

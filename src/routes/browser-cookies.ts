import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import {
  importCookieProfile,
  importCookieProfileFromBuffer,
  listCookieProfiles,
  deleteCookieProfile,
} from "../services/browser-cookies.js";
import { LOCAL_HOST_ID } from "../services/host-registry.js";

// Phase 3, issue #184 — Settings -> Integrations "Import Browser Cookies"
// UI's backend. Read-and-store only: importing runs synchronously against a
// host file path an operator already has access to (same trust level as
// everything else here — gated by the existing global auth gate, not a new
// authorization model). GET never returns decrypted cookie values, only
// summaries — see browser-cookies.ts's own comment on why.
//
// Cookie profiles are primary state, full stop: the browser_cookies table,
// its rows' FK to this process's own `projects`, and the encryption key that
// protects them (app.encryption) all live only on the primary — never on an
// agent (see src/app.ts's MULLION_ROLE === "agent" branch, which skips
// dbPlugin entirely). list/upload/delete are pure DB operations and were
// never host-scoped to begin with, so — unlike every other project-scoped
// route in this app — they run locally here regardless of project.hostId,
// with no RemoteHostClient dispatch at all. import is the one exception: it
// reads a browser profile *directory* off a filesystem, which for a
// remote-hosted project is the agent's filesystem, not this process's — see
// its own handler below for why that's rejected rather than proxied (issue
// #522). Five internal.ts routes existed to support proxying all four of
// these to an agent; four of them called app.db on an agent process, where
// it is always undefined, and 500'd on every request since they were added
// in PR #380 — they were deleted along with the dispatch that called them.

interface ImportCookiesBody {
  browser: "chrome" | "firefox";
  profilePath: string;
  label: string;
}

const importCookiesSchema = {
  body: {
    type: "object",
    required: ["browser", "profilePath", "label"],
    additionalProperties: false,
    properties: {
      browser: { type: "string", enum: ["chrome", "firefox"] },
      profilePath: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
    },
  },
};

interface UploadCookiesBody {
  browser: "chrome" | "firefox";
  fileBase64: string;
  label: string;
}

const uploadCookiesSchema = {
  body: {
    type: "object",
    required: ["browser", "fileBase64", "label"],
    additionalProperties: false,
    properties: {
      browser: { type: "string", enum: ["chrome", "firefox"] },
      fileBase64: { type: "string", minLength: 1 },
      label: { type: "string", minLength: 1 },
    },
  },
};

function getProjectOr404(app: FastifyInstance, projectId: number) {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  return project ?? null;
}

export async function browserCookiesRoute(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { projectId: string } }>(
    "/api/projects/:projectId/browser-cookies",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(app, projectId);
      if (!project) return reply.notFound("Project not found");

      return listCookieProfiles(app, projectId);
    },
  );

  app.post<{ Params: { projectId: string }; Body: ImportCookiesBody }>(
    "/api/projects/:projectId/browser-cookies/import",
    { schema: importCookiesSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(app, projectId);
      if (!project) return reply.notFound("Project not found");

      // A profile path is only meaningful on the filesystem it's read from.
      // For a remote-hosted project that's the agent's disk, not this
      // process's — reading it would need a whole second wire protocol (the
      // agent reading raw cookies and shipping them back over the internal
      // HTTP link) for a case Upload already covers: it takes the cookie
      // file's own bytes from the operator's browser instead of a host path,
      // so it works identically regardless of which host runs the project.
      if (project.hostId !== LOCAL_HOST_ID) {
        return reply.badRequest(
          "Importing from a browser profile path is only supported for local " +
            "projects — use Upload instead (it sends the cookie file itself, so " +
            "it works on any host).",
        );
      }

      try {
        const summary = importCookieProfile(app, projectId, request.body);
        reply.code(201);
        return summary;
      } catch (err) {
        app.log.warn(
          { err, projectId, browser: request.body.browser, label: request.body.label },
          "browser cookie import failed",
        );
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.post<{ Params: { projectId: string }; Body: UploadCookiesBody }>(
    "/api/projects/:projectId/browser-cookies/upload",
    { schema: uploadCookiesSchema },
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      const project = getProjectOr404(app, projectId);
      if (!project) return reply.notFound("Project not found");

      try {
        const summary = importCookieProfileFromBuffer(app, projectId, request.body);
        reply.code(201);
        return summary;
      } catch (err) {
        app.log.warn(
          { err, projectId, browser: request.body.browser, label: request.body.label },
          "browser cookie upload failed",
        );
        return reply.badRequest((err as Error).message);
      }
    },
  );

  app.delete<{ Params: { projectId: string; id: string } }>(
    "/api/projects/:projectId/browser-cookies/:id",
    async (request, reply) => {
      const projectId = Number(request.params.projectId);
      const id = Number(request.params.id);
      if (!Number.isInteger(projectId)) return reply.badRequest("Invalid project id");
      if (!Number.isInteger(id)) return reply.badRequest("Invalid cookie profile id");
      const project = getProjectOr404(app, projectId);
      if (!project) return reply.notFound("Project not found");

      const deleted = deleteCookieProfile(app, projectId, id);
      if (!deleted) return reply.notFound();
      reply.code(204);
    },
  );
}

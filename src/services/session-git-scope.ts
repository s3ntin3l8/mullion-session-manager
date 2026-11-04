// Issue #2570 — session-scoped git. A git request with `?sessionId=` operates
// on that session's host and checkout (the execution-context resolver), not the
// project's. A context that cannot be resolved is a 400 (invalid), 503 (host
// unavailable) or 501 (unsupported) and never falls back to the project's host
// or cwd. Without a `sessionId` the explicit project default is used.
import type { FastifyInstance, FastifyReply } from "fastify";
import { eq } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { executionContextErrorStatus, resolveExecutionContext } from "./execution-context.js";
import { HostRequestError } from "./remote-host-client.js";

export type ProjectRow = typeof projects.$inferSelect;

/**
 * The project row with `hostId`/`cwd` swapped for the session's, so a route
 * runs unchanged against it. Sends the error reply and returns `undefined`
 * when the project or the session context cannot be resolved.
 */
export async function loadScopedProject(
  app: FastifyInstance,
  projectId: number,
  sessionIdRaw: string | undefined,
  reply: FastifyReply,
): Promise<ProjectRow | undefined> {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) {
    reply.notFound();
    return undefined;
  }
  if (sessionIdRaw === undefined) return project;
  if (!/^[1-9][0-9]*$/.test(sessionIdRaw)) {
    reply.badRequest("Invalid sessionId");
    return undefined;
  }
  const got = await resolveExecutionContext(
    app,
    { projectId, sessionId: Number(sessionIdRaw) },
    { preloaded: { project } },
  );
  if (!got.ok) {
    const statusCode = executionContextErrorStatus(got.error.code);
    reply.code(statusCode).send({ statusCode, error: got.error.code, message: got.error.message });
    return undefined;
  }
  return { ...project, hostId: got.context.hostId, cwd: got.context.cwd };
}

/**
 * A mutation on a session's remote checkout whose agent predates the route
 * (a 404) is `unsupported` (501), not "unreachable", and never run elsewhere.
 * Only for a session-scoped request; returns whether it replied.
 */
export function replyUnsupportedOnAgent(
  err: unknown,
  sessionIdRaw: string | undefined,
  hostId: string,
  reply: FastifyReply,
): boolean {
  if (sessionIdRaw === undefined) return false;
  if (!(err instanceof HostRequestError) || err.statusCode !== 404) return false;
  reply.code(501).send({
    statusCode: 501,
    error: "unsupported",
    message: `Host ${hostId}'s Mullion is too old for this git operation`,
  });
  return true;
}

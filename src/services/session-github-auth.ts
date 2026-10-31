import type { FastifyInstance } from "fastify";
import { eq, or } from "drizzle-orm";
import { projects, sessions, tasks } from "../db/schema.js";
import { resolveRepoRef } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { SESSION_TOKEN_RENEW_BEFORE_MS, peekInstallationTokenExpiry } from "./github-app.js";
import {
  GITHUB_REVIEWER_PROVIDER,
  getConfiguredAppId,
  getIntegration,
  getToken,
  resolveGitHubToken,
  resolveReviewerSessionReadToken,
} from "./github-integration.js";
import { getRemoteHostClient } from "./remote-host-client.js";
import {
  GITHUB_TOKEN_MISSING_HINT,
  setSessionGithubAuth,
  type SessionGithubAuth,
} from "./session-github-token.js";

// Primary side of issue #2246: decides WHOSE GitHub token a session's own
// git/gh gets, and delivers it to the host that owns the session. GitHub
// identity follows who is acting — the user's account for a session the user
// drives, the main App for a Task Master worker, the reviewer App (read-only,
// main App read as fallback) for a review session. Task Master's own writes
// (push, PR, merge, review) stay server-side and never use this.

/** Which stream a session belongs to. */
export type SessionGithubRole = "manual" | "worker" | "reviewer";

/** What the primary re-sends tokens ahead of (App tokens live ~1h). */
export { SESSION_TOKEN_RENEW_BEFORE_MS };

export interface ResolveSessionGithubAuthInput {
  role: SessionGithubRole;
  /** The project's GitHub repo; null when it has none (no App token then). */
  repo: { owner: string; repo: string } | null;
}

const NO_APP_HINT =
  "Mullion could not mint a GitHub App token for this repository: install " +
  "the Mullion GitHub App on it, or connect GitHub in Mullion Settings.";

export async function resolveSessionGithubAuth(
  app: FastifyInstance,
  input: ResolveSessionGithubAuthInput,
): Promise<SessionGithubAuth> {
  if (input.role === "manual") {
    // The user's account token, so activity shows as the user, never `[bot]`.
    const token = getToken(app);
    if (!token) return { mode: "manual", hint: GITHUB_TOKEN_MISSING_HINT };
    return { mode: "manual", token, username: getIntegration(app).login ?? "x-access-token" };
  }
  const { repo, role } = input;
  if (!repo) return { mode: "task", hint: NO_APP_HINT };
  const scope = role === "worker" ? "session-work" : "session-read";
  let token: string | null = null;
  let appId: string | null = null;
  if (role === "reviewer") {
    token = await resolveReviewerSessionReadToken(app, repo);
    appId = token ? getConfiguredAppId(app, GITHUB_REVIEWER_PROVIDER) : null;
  }
  if (!token) {
    token = await resolveGitHubToken(app, repo, scope);
    appId = token ? getConfiguredAppId(app) : null;
  }
  if (!token) return { mode: "task", hint: NO_APP_HINT };
  const expiresAt = appId
    ? peekInstallationTokenExpiry(appId, scope, repo.owner, repo.repo, token)
    : undefined;
  return { mode: "task", token, username: "x-access-token", expiresAt };
}

/** Sessions whose App token the refresher keeps renewed (local or remote). */
interface Tracked {
  hostId: string;
  input: ResolveSessionGithubAuthInput;
  expiresAt: number | undefined;
}
const tracked = new Map<string, Tracked>();

/** Remember a delivered App token so it is re-sent before it expires. */
export function trackSessionGithubAuth(
  sessionId: string,
  hostId: string,
  input: ResolveSessionGithubAuthInput,
  auth: SessionGithubAuth,
): void {
  // A user token (no expiry) and an unavailable one need no renewal.
  if (auth.expiresAt === undefined) {
    tracked.delete(sessionId);
    return;
  }
  tracked.set(sessionId, { hostId, input, expiresAt: auth.expiresAt });
}

export function untrackSessionGithubAuth(sessionId: string): void {
  tracked.delete(sessionId);
}

export function clearTrackedSessionGithubAuthForTests(): void {
  tracked.clear();
}

/** Re-sends every tracked token that expires within the renewal window. */
export async function refreshSessionGithubAuth(
  app: FastifyInstance,
  now: number = Date.now(),
): Promise<void> {
  for (const [sessionId, entry] of [...tracked]) {
    if (entry.expiresAt !== undefined && entry.expiresAt - now > SESSION_TOKEN_RENEW_BEFORE_MS) {
      continue;
    }
    const [row] = app.db
      .select({ status: sessions.status })
      .from(sessions)
      .where(eq(sessions.id, Number(sessionId)))
      .all();
    if (row?.status !== "active") {
      tracked.delete(sessionId);
      continue;
    }
    try {
      const auth = await resolveSessionGithubAuth(app, entry.input);
      if (entry.hostId === LOCAL_HOST_ID) deliverLocalSessionGithubAuth(sessionId, auth);
      else await getRemoteHostClient(app, entry.hostId).sendSessionGithubAuth(sessionId, auth);
      entry.expiresAt = auth.expiresAt;
    } catch (err) {
      // The host may be offline; the next tick tries again while the old
      // token is still valid (it is renewed 10 minutes ahead of expiry).
      app.log.warn({ err, sessionId, hostId: entry.hostId }, "session GitHub token refresh failed");
    }
  }
}

/** Local session: straight into this process's store (same one a hosted agent
 * fills over /internal). */
export function deliverLocalSessionGithubAuth(sessionId: string, auth: SessionGithubAuth): void {
  setSessionGithubAuth(sessionId, auth);
}

/**
 * The credential for a LOCAL session the in-memory store has no entry for —
 * the primary restarted (sessions survive it, the store does not) — worked out
 * from the DB: a task's worker session, a task's review session, or neither
 * (a manual session). Primary-only: an agent has no GitHub credentials of its
 * own and gets its entries pushed. The result is cached in the store.
 */
export async function recoverLocalSessionGithubAuth(
  app: FastifyInstance,
  sessionId: string,
): Promise<SessionGithubAuth | undefined> {
  if (app.config.MULLION_ROLE !== "primary") return undefined;
  const id = Number(sessionId);
  const [session] = app.db.select().from(sessions).where(eq(sessions.id, id)).all();
  if (!session) return undefined;
  const [project] = app.db.select().from(projects).where(eq(projects.id, session.projectId)).all();
  if (!project || project.hostId !== LOCAL_HOST_ID) return undefined;
  const [task] = app.db
    .select()
    .from(tasks)
    .where(or(eq(tasks.sessionId, id), eq(tasks.reviewSessionId, id)))
    .all();
  const role: SessionGithubRole = !task
    ? "manual"
    : task.reviewSessionId === id
      ? "reviewer"
      : "worker";
  const auth = await resolveSessionGithubAuth(app, {
    role,
    repo: role === "manual" ? null : await resolveRepoRef(app, project),
  });
  setSessionGithubAuth(sessionId, auth);
  return auth;
}

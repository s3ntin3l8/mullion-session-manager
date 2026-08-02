import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { broadcastToProject } from "../services/github-ws-broadcast.js";
import { getWebhookSecret, resolveRepoRef } from "../services/github-webhook.js";
import { projects, tasks } from "../db/schema.js";
import { invalidatePRsCache } from "../services/github.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { upsertIssueTask } from "../services/task-watcher.js";
import { syncClosedIssueToLocal } from "../services/task-github-sync.js";

const HUB_SIGNATURE_256 = "x-hub-signature-256";
const HUB_EVENT = "x-github-event";

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifySignature(payload: string, signature: string, secret: string): boolean {
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(payload).digest("hex")}`;
  return timingSafeEqual(expected, signature);
}

interface GitHubIssuePayload {
  number?: number;
  title?: string;
  body?: string | null;
  html_url?: string;
  labels?: Array<{ name?: string }>;
}

interface GitHubPushPayload {
  ref?: string;
  after?: string;
  head_commit?: { id?: string };
  repository?: { full_name?: string; open_issues_count?: number };
  action?: string;
  pull_request?: Record<string, unknown>;
  workflow_run?: Record<string, unknown>;
  issue?: GitHubIssuePayload;
  release?: Record<string, unknown>;
}

export async function webhookRoutes(app: FastifyInstance) {
  // No route-level auth — HMAC-SHA256 is the trust mechanism. GitHub can't
  // send custom auth headers. The webhook handler is unauthenticated at the
  // app level and relies entirely on signature verification.
  app.post(
    "/api/webhooks/github",
    { config: { rateLimit: { max: 200, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const secret = getWebhookSecret(app);
      if (!secret) {
        return reply.code(401).send({ error: "webhook not configured" });
      }

      const signature = request.headers[HUB_SIGNATURE_256] as string | undefined;
      if (!signature) {
        return reply.code(401).send({ error: "missing signature" });
      }

      const rawBody =
        typeof request.body === "string" ? request.body : JSON.stringify(request.body);
      if (!verifySignature(rawBody, signature, secret)) {
        return reply.code(401).send({ error: "invalid signature" });
      }

      const event = request.headers[HUB_EVENT] as string | undefined;
      if (!event) {
        return reply.code(200).send({ ok: true });
      }

      const payload: GitHubPushPayload =
        typeof request.body === "string" ? JSON.parse(request.body) : request.body;
      const repoFullName: string | undefined = payload?.repository?.full_name;
      if (!repoFullName) {
        return reply.code(200).send({ ok: true });
      }

      const [owner, repo] = repoFullName.split("/");
      if (!owner || !repo) {
        return reply.code(200).send({ ok: true });
      }

      const repoKey = `${owner}/${repo}`;
      app.log.info({ event, repo: repoKey }, "webhook received");

      // Find all matching projects
      const rows = app.db
        .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
        .from(projects)
        .all();

      // #490 — keeps cwd/hostId alongside id (not just a number[] like
      // before) so the "issues" case below can pass a ProjectRef into
      // syncClosedIssueToLocal without a second query per project.
      // resolveRepoRef is host-agnostic (works for remote-hosted projects
      // too), unlike task-watcher.ts's own poll sweep, which only reads
      // local filesystem state — so webhook-driven ingest reaches
      // remote-hosted projects the poll loop can't, for free.
      const matchedProjects: Array<{ id: number; cwd: string; hostId: string }> = [];
      for (const row of rows) {
        const repoRef = await resolveRepoRef(app, row);
        if (repoRef && repoRef.owner === owner && repoRef.repo === repo) {
          matchedProjects.push({ id: row.id, cwd: row.cwd, hostId: row.hostId ?? "local" });
        }
      }
      const projectIds = matchedProjects.map((p) => p.id);

      // Record in ActivityTracker (best-effort, may not be initialized yet).
      app.githubActivityTracker?.recordWebhook(repoKey);

      // #490 — resolved once per delivery, not per project: whether this
      // install ingests at all, and which label counts as a task label.
      const taskMasterEnabled = resolveTaskMasterConfig(app).enabled;
      const taskLabel = app.config.MULLION_TASK_LABEL;

      // Broadcast event to each matching project
      const action = payload.action;
      for (const projectId of projectIds) {
        const pid = String(projectId);
        switch (event) {
          case "pull_request": {
            const pr = payload.pull_request;
            if (!pr) break;
            let prAction: "opened" | "closed" | "sync" = "sync";
            if (action === "opened") prAction = "opened";
            else if (action === "closed") prAction = "closed";
            else if (action === "synchronize") prAction = "sync";
            broadcastToProject(pid, {
              type: "pr",
              action: prAction,
              projectId: pid,
              pr: typeof pr === "object" ? pr : {},
            });
            break;
          }
          case "workflow_run": {
            const workflowRun = payload.workflow_run;
            if (!workflowRun) break;
            broadcastToProject(pid, {
              type: "ci",
              action: action === "completed" ? "completed" : "started",
              projectId: pid,
              run: typeof workflowRun === "object" ? workflowRun : {},
            });
            break;
          }
          case "issues": {
            const issue = payload.issue;
            if (!issue) break;
            const openCount = payload.repository?.open_issues_count ?? 0;
            broadcastToProject(pid, {
              type: "issue",
              action: action === "closed" ? "closed" : "opened",
              projectId: pid,
              counts: { open: openCount, closed: 0 },
            });

            // #490 — webhook-driven task ingest, sharing upsertIssueTask
            // with the poll loop (task-watcher.ts) so the two can't drift.
            // Deliberately narrower than the poll loop's own read-back:
            // only "labeled" (ingest) and "closed" (the same done-sync the
            // poll loop's read-back already does, gated the same way via
            // canTransition inside syncClosedIssueToLocal) are handled.
            // "unlabeled" is out of scope — the poll loop doesn't react to
            // it either (see task-watcher.ts's own doc comment), and
            // handling it only here would be a webhook-only behavior.
            if (taskMasterEnabled && issue.number !== undefined) {
              if (
                action === "labeled" &&
                issue.title !== undefined &&
                issue.html_url !== undefined &&
                (issue.labels ?? []).some((l) => l.name === taskLabel)
              ) {
                upsertIssueTask(app, projectId, {
                  number: issue.number,
                  title: issue.title,
                  body: issue.body ?? null,
                  htmlUrl: issue.html_url,
                });
              } else if (action === "closed") {
                const projectRef = matchedProjects.find((p) => p.id === projectId);
                if (projectRef) {
                  const [task] = app.db
                    .select()
                    .from(tasks)
                    .where(and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issue.number)))
                    .all();
                  if (task) {
                    await syncClosedIssueToLocal(app, task, {
                      cwd: projectRef.cwd,
                      hostId: projectRef.hostId,
                    });
                  }
                }
              }
            }
            break;
          }
          case "push": {
            const ref: string | undefined = payload.ref;
            const sha: string | undefined = payload.head_commit?.id ?? payload.after;
            if (!ref) break;
            const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
            broadcastToProject(pid, {
              type: "push",
              projectId: pid,
              branch,
              sha: sha ?? "",
            });
            break;
          }
          case "release": {
            const release = payload.release;
            if (!release) break;
            broadcastToProject(pid, {
              type: "release",
              action: "published",
              projectId: pid,
              release: typeof release === "object" ? release : {},
            });
            break;
          }
        }
      }

      // Invalidate the per-repo PRs cache so the next REST read goes live
      // (the poller will re-fill it on the next tick).
      invalidatePRsCache(owner, repo);

      return reply.code(200).send({ ok: true });
    },
  );
}

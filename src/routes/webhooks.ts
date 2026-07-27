import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { broadcastToProject } from "../services/github-ws-broadcast.js";
import { getWebhookSecret, resolveRepoRef } from "../services/github-webhook.js";
import { projects } from "../db/schema.js";
import { invalidatePRsCache } from "../services/github.js";

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

interface GitHubPushPayload {
  ref?: string;
  after?: string;
  head_commit?: { id?: string };
  repository?: { full_name?: string; open_issues_count?: number };
  action?: string;
  pull_request?: Record<string, unknown>;
  workflow_run?: Record<string, unknown>;
  issue?: Record<string, unknown>;
  release?: Record<string, unknown>;
}

export async function webhookRoutes(app: FastifyInstance) {
  // No route-level auth — HMAC-SHA256 is the trust mechanism. GitHub can't
  // send custom auth headers. The webhook handler is unauthenticated at the
  // app level and relies entirely on signature verification.
  app.post("/api/webhooks/github", async (request, reply) => {
    const secret = getWebhookSecret(app);
    if (!secret) {
      return reply.code(401).send({ error: "webhook not configured" });
    }

    const signature = request.headers[HUB_SIGNATURE_256] as string | undefined;
    if (!signature) {
      return reply.code(401).send({ error: "missing signature" });
    }

    const rawBody = typeof request.body === "string" ? request.body : JSON.stringify(request.body);
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

    const projectIds: number[] = [];
    for (const row of rows) {
      const repoRef = await resolveRepoRef(app, row);
      if (repoRef && repoRef.owner === owner && repoRef.repo === repo) {
        projectIds.push(row.id);
      }
    }

    // Record in ActivityTracker (best-effort, may not be initialized yet).
    app.githubActivityTracker?.recordWebhook(repoKey);

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
  });
}

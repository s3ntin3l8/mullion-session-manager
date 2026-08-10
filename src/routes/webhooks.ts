import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq, and } from "drizzle-orm";
import { broadcastToProject } from "../services/github-ws-broadcast.js";
import { getWebhookSecret, resolveRepoRef } from "../services/github-webhook.js";
import { projects, tasks } from "../db/schema.js";
import { invalidatePRsCache } from "../services/github.js";
import { resolveTaskMasterConfig } from "../services/task-config.js";
import { upsertIssueTask } from "../services/task-watcher.js";
import { syncClosedIssueToLocal, syncUnlabeledIssueToLocal } from "../services/task-github-sync.js";

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

function verifySignature(payload: string | Buffer, signature: string, secret: string): boolean {
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
  // Present alongside `issue` on "labeled"/"unlabeled" deliveries — the
  // single label that was added/removed, a sibling of `issue`, not nested
  // inside it. `issue.labels` (above) is the issue's CURRENT full label
  // list after the change; this is which one changed.
  label?: { name?: string };
  release?: Record<string, unknown>;
}

export async function webhookRoutes(app: FastifyInstance) {
  // GitHub's HMAC (X-Hub-Signature-256) is computed over the exact bytes it
  // sent on the wire. Fastify's inherited `application/json` parser hands
  // this handler an already-*parsed* object, so reconstructing "the same
  // bytes" via `JSON.stringify(request.body)` is a lossy re-serialization —
  // a payload that doesn't round-trip byte-identically (key order, unicode
  // escape variance, whitespace) would silently and permanently 401, and an
  // empty body makes `request.body === undefined`, and
  // `JSON.stringify(undefined)` is the *value* `undefined`, not a string, so
  // `.update(undefined)` used to throw a 500 instead of the intended 401
  // (AS6). Removing the inherited parsers and installing a single raw-buffer
  // "*" one captures the exact bytes GitHub signed instead — verify the HMAC
  // against those, then JSON.parse only after the signature has checked out.
  // This route is registered as its own top-level plugin (see
  // `app.register(webhookRoutes)` in app.ts), so it already has its own
  // encapsulated Fastify context — these parser calls only affect this
  // route, the same isolation internal.ts's own dev-server-proxy route
  // documents for the identical pattern.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer" }, (_req, payload, done) => {
    done(null, payload);
  });

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

      // The raw bytes captured by the content-type parser above — a Buffer,
      // except when GitHub sends a genuinely empty POST with no
      // Content-Type header at all, which no parser matches, leaving
      // request.body undefined. Falling back to an empty Buffer keeps the
      // HMAC comparison well-defined (it will simply never match a real
      // signature) rather than throwing.
      const rawBody: Buffer = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
      if (!verifySignature(rawBody, signature, secret)) {
        return reply.code(401).send({ error: "invalid signature" });
      }

      const event = request.headers[HUB_EVENT] as string | undefined;
      if (!event) {
        return reply.code(200).send({ ok: true });
      }

      let payload: GitHubPushPayload;
      try {
        payload = rawBody.length > 0 ? JSON.parse(rawBody.toString("utf8")) : {};
      } catch {
        return reply.code(400).send({ error: "invalid JSON body" });
      }
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

            // #490/#490a — webhook-driven task ingest, sharing
            // upsertIssueTask (ingest), syncClosedIssueToLocal (closed),
            // and syncUnlabeledIssueToLocal (unlabeled) with the poll loop
            // (task-watcher.ts) so the two paths can't drift. "labeled"/
            // "opened" ingest (the latter covers an issue created with the
            // task label already applied, which never fires a separate
            // "labeled" event), "closed" (done-sync, gated via
            // canTransition inside syncClosedIssueToLocal), and "unlabeled"
            // (gated to backlog/ready inside syncUnlabeledIssueToLocal) are
            // all handled — the same three cases the poll loop's read-back
            // now covers, so this is no longer narrower than it.
            //
            // Wrapped in try/catch (Hermes review, PR #503 follow-up):
            // this handler has no other try/catch anywhere, and a
            // synchronous DB throw (e.g. a locked SQLite file) from the
            // lookups/upsert below would otherwise surface as a 500,
            // breaking the documented always-200 posture the rest of this
            // route relies on. The closed/unlabeled sync calls themselves
            // are fire-and-forget (see their own comment below) and handle
            // their own errors via a `.catch()`, not this try/catch.
            if (taskMasterEnabled && issue.number !== undefined) {
              try {
                if (
                  // Hermes review, PR #503: an issue created with the task
                  // label already applied (label picker at creation, or the
                  // API's create-with-labels) fires "opened", not
                  // "labeled" — gating on "labeled" alone would leave it
                  // waiting for the next poll tick despite webhooks being
                  // enabled.
                  (action === "labeled" || action === "opened") &&
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
                } else if (action === "closed" || action === "unlabeled") {
                  // "unlabeled" only proceeds when the label GitHub reports
                  // removed is the task label — an issue can have other
                  // labels come and go with no relevance here.
                  if (action === "unlabeled" && payload.label?.name !== taskLabel) break;
                  const projectRef = matchedProjects.find((p) => p.id === projectId);
                  if (projectRef) {
                    const [task] = app.db
                      .select()
                      .from(tasks)
                      .where(
                        and(eq(tasks.projectId, projectId), eq(tasks.issueNumber, issue.number)),
                      )
                      .all();
                    if (task) {
                      const projectRefArg = { cwd: projectRef.cwd, hostId: projectRef.hostId };
                      // Deliberately NOT awaited (Hermes review, PR #510):
                      // "unlabeled" can drive syncUnlabeledIssueToLocal's
                      // "failed" sync, which makes up to 3 sequential
                      // GitHub write calls (2x removeLabel + createComment)
                      // — awaiting that inline risks pushing this response
                      // past GitHub's ~10s webhook delivery timeout,
                      // triggering a retried (harmless, idempotent, but
                      // wasteful) delivery. Both sync functions already
                      // catch and log their own failures internally (never
                      // throw), so this `.catch()` is a last-resort net,
                      // not the primary error path.
                      const syncPromise =
                        action === "closed"
                          ? syncClosedIssueToLocal(app, task, projectRefArg)
                          : syncUnlabeledIssueToLocal(app, task, projectRefArg);
                      syncPromise.catch((err) => {
                        app.log.warn(
                          { err, event, action, projectId, issueNumber: issue.number },
                          "[webhooks] background task sync failed",
                        );
                      });
                    }
                  }
                }
              } catch (err) {
                app.log.warn(
                  { err, event, action, projectId, issueNumber: issue.number },
                  "[webhooks] task ingest/sync failed — delivery still acknowledged",
                );
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

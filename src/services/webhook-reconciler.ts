// #490b — repairs the one gap `enableWebhooks` itself can't close: it only
// ever registers a hook for the projects that exist *at the moment it's
// called*. A project created afterward (or whose earlier registration
// attempt failed — a rate limit, a token that briefly lost hook-admin
// scope) has no hook and nothing else detects it. `routes/projects.ts`'s
// create/update handlers also call `registerProjectWebhook` directly for
// the common case (a project added through the UI while webhooks are
// already on); this reconciler is the backstop for everything that path
// doesn't cover — installs where the primary was down when a project was
// added via some other route (seed script, direct DB write), or a
// registration attempt that failed outright.
//
// Deliberately NOT on the exited-session reconciler's 30s cadence: each
// pass here costs a `resolveRepoRef` plus (for anything actually missing)
// a real GitHub API round trip per project, so a 30s interval would mean
// a GitHub API call per project every half-minute forever. This is a
// repair path for a rare condition, not a hot loop — a multi-hour interval
// plus a single pass shortly after boot is what "eventually self-heals"
// needs, not "immediately."
import type { FastifyInstance } from "fastify";
import { and, eq, gte, isNotNull, isNull, notInArray } from "drizzle-orm";
import { integrations, projects, webhookRegistrations } from "../db/schema.js";
import { GITHUB_PROVIDER, getToken } from "./github-integration.js";
import {
  buildWebhookUrl,
  getWebhookSecret,
  registerProjectWebhook,
  WEBHOOK_EVENTS_VERSION,
} from "./github-webhook.js";

// 6 hours: frequent enough that a missed project doesn't stay unregistered
// for days, rare enough that this never resembles the adaptive PR/CI
// poller's cadence (that one exists specifically to be near-real-time;
// this one exists to catch what near-real-time paths missed).
const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000;
// A short delay rather than an immediate run at boot — mirrors
// task-watcher.ts's own startup-stagger reasoning: let the rest of boot
// (DB migrations, other plugins) settle before the first network-touching
// pass, without making a rare condition wait a full interval to self-heal
// after every restart.
const INITIAL_DELAY_MS = 30_000;

async function reconcileOnce(app: FastifyInstance): Promise<void> {
  if (!app.config.MULLION_WEBHOOK_BASE_URL) return;

  const row = app.db
    .select({ webhookEnabled: integrations.webhookEnabled })
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .get();
  if (!row?.webhookEnabled) return;

  const token = getToken(app);
  if (!token) return;
  const secret = getWebhookSecret(app);
  if (!secret) return;

  const webhookUrl = buildWebhookUrl(app);

  // Already-registered projects cost nothing to skip — only genuinely
  // missing (or stale-event-list, #667) ones pay for a resolveRepoRef +
  // GitHub round trip. This is what keeps a routine reconcile pass cheap
  // regardless of how many projects are already covered. `lastError IS
  // NULL` matters as much as `hookId IS NOT NULL` here: a rotation/PATCH
  // that failed after an earlier successful registration leaves the old
  // hookId in place alongside a fresh lastError (see
  // `upsertWebhookRegistration`'s own comment) — that row still needs a
  // retry, it just isn't "missing" in the hookId-null sense.
  //
  // #667 — `eventsVersion >= WEBHOOK_EVENTS_VERSION` is now part of this
  // same "already covered" test. Without it, this is the ONLY gap:
  // registerProjectWebhook's own registerHook (github-webhook.ts) PATCHes
  // an existing hook with the current WEBHOOK_EVENTS on every call it's
  // actually given — but nothing else ever re-invokes it for a hook this
  // set already excludes as "healthy". A hook registered before an event
  // was added to WEBHOOK_EVENTS would otherwise keep its stale
  // subscription forever. A stale-but-otherwise-healthy row here still
  // goes through the exact same `registerProjectWebhook` call as a
  // genuinely missing one below — PATCH, not re-create — so this costs one
  // extra round trip per stale project, once, the first reconcile pass
  // after an upgrade.
  const upToDateProjectIds = new Set(
    app.db
      .select({ projectId: webhookRegistrations.projectId })
      .from(webhookRegistrations)
      .where(
        and(
          isNotNull(webhookRegistrations.hookId),
          isNull(webhookRegistrations.lastError),
          gte(webhookRegistrations.eventsVersion, WEBHOOK_EVENTS_VERSION),
        ),
      )
      .all()
      .map((r) => r.projectId),
  );

  const staleOrMissingRows = app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .where(
      upToDateProjectIds.size > 0 ? notInArray(projects.id, [...upToDateProjectIds]) : undefined,
    )
    .all();

  if (staleOrMissingRows.length === 0) return;

  let registered = 0;
  for (const row of staleOrMissingRows) {
    const outcome = await registerProjectWebhook(app, row, token, webhookUrl, secret);
    if (outcome === "registered") registered++;
  }
  if (registered > 0) {
    app.log.info(
      { registered, checked: staleOrMissingRows.length },
      "[webhook-reconciler] registered/refreshed hooks for projects missed by earlier registration or on a stale event subscription",
    );
  }
}

export function startWebhookReconciler(app: FastifyInstance): () => void {
  let interval: ReturnType<typeof setInterval> | null = null;
  const initialTimer = setTimeout(() => {
    reconcileOnce(app).catch((err) => {
      app.log.warn({ err }, "[webhook-reconciler] reconcile pass failed");
    });
    interval = setInterval(() => {
      reconcileOnce(app).catch((err) => {
        app.log.warn({ err }, "[webhook-reconciler] reconcile pass failed");
      });
    }, RECONCILE_INTERVAL_MS);
    interval.unref();
  }, INITIAL_DELAY_MS);
  initialTimer.unref();

  return () => {
    clearTimeout(initialTimer);
    if (interval) clearInterval(interval);
  };
}

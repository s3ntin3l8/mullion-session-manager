import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations, projects, webhookRegistrations } from "../db/schema.js";
import { getToken, GITHUB_PROVIDER } from "./github-integration.js";
import { validateGitHubRepoRef } from "./github.js";
import { resolveRepoRef } from "./host-git.js";
import { githubApiFetch } from "./github-fetch.js";

function generateSecret(): string {
  return crypto.randomBytes(32).toString("hex");
}

interface GitHubHookApiItem {
  id: number;
  active: boolean;
  config: { url?: string };
}

async function getExistingHooks(
  token: string,
  owner: string,
  repo: string,
): Promise<GitHubHookApiItem[]> {
  validateGitHubRepoRef(owner, repo);
  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) return [];
  return (await res.json()) as GitHubHookApiItem[];
}

/**
 * Registers (or, for an already-existing Mullion hook, re-syncs) the
 * webhook for `owner/repo` and returns GitHub's hook id, so callers can
 * persist it (see `webhook_registrations`, #490b).
 *
 * #490b — an existing hook with a matching URL is now PATCHed, not skipped
 * outright. Before this fix, a second `enableWebhooks` call (e.g. after a
 * restart with no `MULLION_WEBHOOK_SECRET` set, so a fresh one is minted
 * every time — see `enableWebhooks` below) persisted a NEW secret locally
 * while the existing GitHub hook kept signing with the OLD one, silently
 * 401ing every subsequent delivery until someone noticed and manually
 * disabled/re-enabled. PATCHing keeps the two in sync on every call, not
 * just the first.
 */
async function registerHook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string,
): Promise<number> {
  validateGitHubRepoRef(owner, repo);
  const existing = await getExistingHooks(token, owner, repo);
  const mullionHook = existing.find((h) => h.active && h.config.url === webhookUrl);

  if (mullionHook) {
    const res = await githubApiFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${mullionHook.id}`,
      {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          active: true,
          config: { url: webhookUrl, content_type: "json", secret, insecure_ssl: "0" },
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "unknown");
      throw new Error(
        `Failed to update webhook for ${owner}/${repo}: HTTP ${res.status} — ${body}`,
      );
    }
    return mullionHook.id;
  }

  const res = await githubApiFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: ["pull_request", "push", "issues", "workflow_run", "release"],
        config: {
          url: webhookUrl,
          content_type: "json",
          secret,
          insecure_ssl: "0",
        },
      }),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(
      `Failed to register webhook for ${owner}/${repo}: HTTP ${res.status} — ${body}`,
    );
  }
  const created = (await res.json()) as GitHubHookApiItem;
  return created.id;
}

/** Exported (#490b) so `routes/projects.ts`'s DELETE handler can tear down
 * a single project's own hook on removal, not just the install-wide
 * disable path above. */
export async function unregisterHook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
): Promise<void> {
  validateGitHubRepoRef(owner, repo);
  const existing = await getExistingHooks(token, owner, repo);
  for (const hook of existing) {
    if (hook.active && hook.config.url === webhookUrl) {
      await githubApiFetch(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hook.id}`,
        {
          method: "DELETE",
          headers: { Authorization: `Bearer ${token}` },
        },
      ).catch(() => {});
    }
  }
}

export function buildWebhookUrl(app: FastifyInstance): string {
  return `${app.config.MULLION_WEBHOOK_BASE_URL.replace(/\/+$/, "")}/api/webhooks/github`;
}

/** #490b — persists (or updates) this project's registration record. Kept
 * separate from `registerProjectWebhook` below so a caller that already
 * has a hookId/error in hand (there's only one right now, but this keeps
 * the write path testable in isolation) doesn't need to re-derive it. */
function upsertWebhookRegistration(
  app: FastifyInstance,
  projectId: number,
  owner: string,
  repo: string,
  result: { hookId: number } | { error: string },
): void {
  const now = new Date();
  if ("hookId" in result) {
    app.db
      .insert(webhookRegistrations)
      .values({ projectId, owner, repo, hookId: result.hookId, registeredAt: now, lastError: null })
      .onConflictDoUpdate({
        target: webhookRegistrations.projectId,
        set: { owner, repo, hookId: result.hookId, registeredAt: now, lastError: null },
      })
      .run();
  } else {
    // A failed attempt records the error but deliberately does NOT touch
    // an existing hookId/registeredAt on conflict *for the same repo* — if
    // a previous attempt for this project already succeeded, this failure
    // shouldn't erase that record (the old hook is presumably still live
    // on GitHub; only a fresh successful (re-)registration should overwrite
    // it). But if `owner`/`repo` themselves changed (the project's cwd now
    // points at a different repo), the stored hookId belongs to the *old*
    // repo, not this one — leaving it in place would misreport this row as
    // "registered" for a repo that never actually got a hook (inflating
    // `webhookRegisteredCount` and making the reconciler skip it forever),
    // and would point a later DELETE's unregister at the wrong repo. Clear
    // it in that case so the row honestly reflects "not registered here".
    const existing = app.db
      .select({ owner: webhookRegistrations.owner, repo: webhookRegistrations.repo })
      .from(webhookRegistrations)
      .where(eq(webhookRegistrations.projectId, projectId))
      .get();
    const repoChanged =
      existing !== undefined && (existing.owner !== owner || existing.repo !== repo);
    app.db
      .insert(webhookRegistrations)
      .values({ projectId, owner, repo, hookId: null, registeredAt: null, lastError: result.error })
      .onConflictDoUpdate({
        target: webhookRegistrations.projectId,
        set: repoChanged
          ? { owner, repo, hookId: null, registeredAt: null, lastError: result.error }
          : { owner, repo, lastError: result.error },
      })
      .run();
  }
}

type WebhookRegistrationOutcome = "registered" | "skipped" | "failed";

/**
 * #490b — the single per-project registration path shared by
 * `enableWebhooks` (below), a project's own create/update route
 * (`routes/projects.ts`), and the reconciler (`webhook-reconciler.ts`) —
 * so "register a hook for this project" has exactly one implementation
 * regardless of what triggered it. Persists the outcome via
 * `upsertWebhookRegistration` either way; `"skipped"` (no resolvable repo)
 * deliberately does NOT write a registration row — there's nothing to
 * track for a project with no github.com remote.
 */
export async function registerProjectWebhook(
  app: FastifyInstance,
  row: { id: number; cwd: string; hostId: string },
  token: string,
  webhookUrl: string,
  secret: string,
): Promise<WebhookRegistrationOutcome> {
  const repoRef = await resolveRepoRef(app, row);
  if (!repoRef) return "skipped";

  try {
    const hookId = await registerHook(token, repoRef.owner, repoRef.repo, webhookUrl, secret);
    upsertWebhookRegistration(app, row.id, repoRef.owner, repoRef.repo, { hookId });
    return "registered";
  } catch (err) {
    app.log.warn(
      { owner: repoRef.owner, repo: repoRef.repo, err },
      "[github-webhook] failed to register hook",
    );
    upsertWebhookRegistration(app, row.id, repoRef.owner, repoRef.repo, {
      error: err instanceof Error ? err.message : String(err),
    });
    return "failed";
  }
}

interface WebhookRegistrationResult {
  reposSucceeded: number;
  reposFailed: number;
}

export async function enableWebhooks(app: FastifyInstance): Promise<WebhookRegistrationResult> {
  const webhookUrl = buildWebhookUrl(app);
  const token = getToken(app);
  if (!token) throw new Error("No GitHub token configured");

  let secret = app.config.MULLION_WEBHOOK_SECRET;
  if (!secret) {
    secret = generateSecret();
  }

  const rows = app.db
    .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
    .from(projects)
    .all();

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    const outcome = await registerProjectWebhook(app, row, token, webhookUrl, secret);
    if (outcome === "registered") succeeded++;
    else if (outcome === "failed") failed++;
  }

  const secretEnc = app.encryption.encryptString(secret);
  app.db
    .insert(integrations)
    .values({
      provider: GITHUB_PROVIDER,
      webhookEnabled: true,
      webhookSecretEnc: secretEnc,
    })
    .onConflictDoUpdate({
      target: integrations.provider,
      set: {
        webhookEnabled: true,
        webhookSecretEnc: secretEnc,
      },
    })
    .run();

  return { reposSucceeded: succeeded, reposFailed: failed };
}

export async function disableWebhooks(app: FastifyInstance): Promise<void> {
  const webhookUrl = buildWebhookUrl(app);
  const token = getToken(app);

  if (token) {
    const rows = app.db
      .select({ id: projects.id, cwd: projects.cwd, hostId: projects.hostId })
      .from(projects)
      .all();

    for (const row of rows) {
      const repoRef = await resolveRepoRef(app, row);
      if (!repoRef) continue;

      try {
        await unregisterHook(token, repoRef.owner, repoRef.repo, webhookUrl);
      } catch (err) {
        app.log.warn(
          { owner: repoRef.owner, repo: repoRef.repo, err },
          "[github-webhook] failed to unregister hook",
        );
      }
    }
  }

  app.db
    .update(integrations)
    .set({ webhookEnabled: false })
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .run();

  // #490b — clear every registration record install-wide: the hooks
  // themselves were just torn down above (best-effort), and leaving
  // `hookId` populated would both misreport `webhookRegisteredCount` as
  // nonzero while disabled and let a later reconcile pass believe these
  // projects are already covered, skipping them.
  app.db.update(webhookRegistrations).set({ hookId: null, registeredAt: null }).run();
}

/** Gated on `webhookEnabled`, not just "is a secret stored" (#490b) — a
 * stale secret surviving a disable used to still verify incoming
 * deliveries against a hook GitHub itself no longer has (or that was
 * force-disabled without a matching unregister), letting a webhook that
 * should have stopped keep driving Task Master ingest/sync. */
export function getWebhookSecret(app: FastifyInstance): string | null {
  const row = app.db
    .select({
      webhookSecretEnc: integrations.webhookSecretEnc,
      webhookEnabled: integrations.webhookEnabled,
    })
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .get();
  if (!row?.webhookEnabled || !row.webhookSecretEnc) return null;
  return app.encryption.decryptString(row.webhookSecretEnc);
}

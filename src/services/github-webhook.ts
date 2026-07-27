import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations, projects } from "../db/schema.js";
import { getToken, GITHUB_PROVIDER } from "./github-integration.js";
import { parseGitRemote, type GitHubRepoRef } from "./git-remote.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { getRemoteHostClient } from "./remote-host-client.js";

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "mullion-session-manager";

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
  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) return [];
  return (await res.json()) as GitHubHookApiItem[];
}

async function registerHook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
  secret: string,
): Promise<void> {
  // Check for existing mullion webhook first.
  const existing = await getExistingHooks(token, owner, repo);
  const mullionHook = existing.find((h) => h.active && h.config.url === webhookUrl);
  if (mullionHook) return;

  const res = await fetch(
    `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: "web",
        active: true,
        events: [
          "pull_request",
          "check_run",
          "check_suite",
          "push",
          "issues",
          "workflow_run",
          "release",
          "status",
        ],
        config: {
          url: webhookUrl,
          content_type: "json",
          secret,
          insecure_ssl: "0",
        },
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!res.ok) {
    const body = await res.text().catch(() => "unknown");
    throw new Error(
      `Failed to register webhook for ${owner}/${repo}: HTTP ${res.status} — ${body}`,
    );
  }
}

async function unregisterHook(
  token: string,
  owner: string,
  repo: string,
  webhookUrl: string,
): Promise<void> {
  const existing = await getExistingHooks(token, owner, repo);
  for (const hook of existing) {
    if (hook.active && hook.config.url === webhookUrl) {
      await fetch(
        `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/hooks/${hook.id}`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "User-Agent": USER_AGENT,
          },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      ).catch(() => {});
    }
  }
}

async function resolveRepoRef(
  app: FastifyInstance,
  row: { cwd: string; hostId: string },
): Promise<GitHubRepoRef | null> {
  if (row.hostId === LOCAL_HOST_ID) {
    return parseGitRemote(row.cwd);
  }
  try {
    return await getRemoteHostClient(app, row.hostId).resolveGitHubRepo(row.cwd);
  } catch {
    return null;
  }
}

interface WebhookRegistrationResult {
  reposSucceeded: number;
  reposFailed: number;
}

export async function enableWebhooks(app: FastifyInstance): Promise<WebhookRegistrationResult> {
  const webhookUrl = `${app.config.MULLION_WEBHOOK_BASE_URL.replace(/\/+$/, "")}/api/webhooks/github`;
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
    const repoRef = await resolveRepoRef(app, row);
    if (!repoRef) continue;

    try {
      await registerHook(token, repoRef.owner, repoRef.repo, webhookUrl, secret);
      succeeded++;
    } catch (err) {
      app.log.warn(
        { owner: repoRef.owner, repo: repoRef.repo, err },
        "[github-webhook] failed to register hook",
      );
      failed++;
    }
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
  const webhookUrl = `${app.config.MULLION_WEBHOOK_BASE_URL.replace(/\/+$/, "")}/api/webhooks/github`;
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
}

export function getWebhookSecret(app: FastifyInstance): string | null {
  const [row] = app.db
    .select({ webhookSecretEnc: integrations.webhookSecretEnc })
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .all();
  if (!row?.webhookSecretEnc) return null;
  return app.encryption.decryptString(row.webhookSecretEnc);
}

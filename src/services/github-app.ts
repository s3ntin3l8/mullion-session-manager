import crypto from "node:crypto";
import { validateGitHubRepoRef } from "./github.js";

// #489 — GitHub App installation tokens for Task Master's own write paths
// (task-github-sync.ts, task-promote.ts, git-push.ts), configured
// independently of the shared PAT/OAuth token in github-integration.ts.
// This is a deliberate, narrowly-scoped reversal of a prior decision
// (docs/roadmap.md's issue #60 "GitHub App investigation," resolved by #384
// in favor of PAT-registered webhooks + adaptive polling) — scoped to Task
// Master's writes only; the base GitHub integration (repo-status widget,
// PR/CI poller, webhook registration) keeps using the PAT regardless.
//
// A GitHub App installation token scopes to a *repository* + a permission
// set, never to an individual issue/task — "per-task" in practice means
// minted fresh per task, limited to that task's repo and the minimum
// permission set, short-lived (~1h), not a token bound to one issue number.

const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "mullion-session-manager";
const REQUEST_TIMEOUT_MS = 5_000;
// GitHub rejects an app JWT with `exp` more than 10 minutes out; 9 minutes
// leaves margin for clock skew between this host and GitHub's.
const APP_JWT_TTL_SECONDS = 9 * 60;

export class GitHubAppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAppError";
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Signs a GitHub App JWT (RS256) per GitHub's own spec: `iat` backdated 60s
 * to tolerate clock skew, `exp` within the 10-minute ceiling, `iss` the
 * numeric App id. Uses `node:crypto` directly rather than a JWT library —
 * the claim set is fixed and tiny, not worth a dependency.
 */
export function signAppJwt(appId: string, privateKeyPem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({ iat: now - 60, exp: now + APP_JWT_TTL_SECONDS, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  let signature: Buffer;
  try {
    signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKeyPem);
  } catch {
    // Hermes review, PR #504: deliberately drops the underlying error's
    // own message — some Node/OpenSSL versions echo key material back in
    // a signing error string, and this error is both logged
    // (app.log.warn in resolveGitHubToken) and surfaced to callers, so
    // there's no safe place downstream to redact it. A fixed message is
    // the only sanitization that actually holds.
    throw new GitHubAppError("Failed to sign GitHub App JWT — check the configured private key");
  }
  return `${signingInput}.${base64url(signature)}`;
}

interface InstallationSummary {
  id: number;
  login: string;
}

/**
 * Lists this App's installations, so a repo owner can be resolved to an
 * installation id. Not cached — called only on a cache miss in
 * `resolveGitHubToken`, at most once per (owner, repo) per token TTL.
 *
 * Hermes review, PR #504: capped at the first 100 installations (one
 * page, no `Link`-header pagination) — deliberately, matching
 * `github.ts`'s own "glance list, not an exhaustive report" scope for
 * `listLabeledIssues`. An App installed on more than 100 accounts would
 * silently fail to resolve an owner past that page, falling back to the
 * shared PAT — acceptable for now given the intended usage (a handful of
 * repos/orgs an install actually writes to), but a real limit if this
 * ever needs to scale past it.
 */
export async function listInstallations(appJwt: string): Promise<InstallationSummary[]> {
  const res = await fetch(`${GITHUB_API_BASE}/app/installations?per_page=100`, {
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new GitHubAppError(`GitHub App installations list failed (HTTP ${res.status})`);
  }
  const items = (await res.json()) as Array<{ id: number; account?: { login?: string } }>;
  return items
    .filter((item) => item.account?.login)
    .map((item) => ({ id: item.id, login: item.account!.login! }));
}

export interface InstallationToken {
  token: string;
  expiresAt: Date;
}

/**
 * Exchanges an App JWT for a short-lived installation token, narrowed to
 * exactly one repository and the minimum permission set Task Master's
 * writes need — never the installation's full repository/permission grant.
 * Takes `owner`/`repo` separately (not a pre-joined string) so
 * `validateGitHubRepoRef` can run right at the point of the outbound
 * request — `owner`/`repo` ultimately trace back to a project's
 * `.git/config` (file data), the same "file data reaching an outbound
 * request" shape `github.ts`'s own request functions guard against
 * (CodeQL's js/request-forgery query).
 */
export async function mintInstallationToken(
  appJwt: string,
  installationId: number,
  owner: string,
  repo: string,
): Promise<InstallationToken> {
  validateGitHubRepoRef(owner, repo);
  const res = await fetch(`${GITHUB_API_BASE}/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${appJwt}`,
      Accept: "application/vnd.github+json",
      "User-Agent": USER_AGENT,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      repositories: [`${owner}/${repo}`],
      permissions: { issues: "write", pull_requests: "write", contents: "write" },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new GitHubAppError(
      `GitHub App installation token exchange failed (HTTP ${res.status}) for installation ${installationId}`,
    );
  }
  const body = (await res.json()) as { token: string; expires_at: string };
  return { token: body.token, expiresAt: new Date(body.expires_at) };
}

/**
 * Resolves `owner` to an installation id by listing every installation of
 * this App and matching on the account login (case-insensitive — GitHub
 * logins are case-preserving but not case-sensitive). Returns `null` when
 * the App isn't installed on that owner's account at all — the caller's
 * job to fall back, not this function's.
 */
export async function resolveInstallationId(appJwt: string, owner: string): Promise<number | null> {
  const installations = await listInstallations(appJwt);
  const match = installations.find((i) => i.login.toLowerCase() === owner.toLowerCase());
  return match?.id ?? null;
}

// (owner, repo) -> cached token, evicted 60s before actual expiry so a
// caller never hands out a token GitHub is about to reject mid-flight.
// Keyed by owner/repo rather than installationId/repo specifically so a
// cache hit skips resolveInstallationId's own fetch entirely — see
// getInstallationToken below.
const tokenCache = new Map<string, InstallationToken>();
const CACHE_SAFETY_MARGIN_MS = 60_000;

function cacheKey(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/**
 * Mints (or returns a cached, still-valid) installation token for
 * `owner/repo`. The only entry point `github-integration.ts`'s
 * `resolveGitHubToken` calls — everything above is plumbing this
 * orchestrates. Returns `null` when the App has no installation covering
 * `owner`, letting the caller fall back to the shared PAT rather than
 * failing the write outright.
 */
export async function getInstallationToken(
  appId: string,
  privateKeyPem: string,
  owner: string,
  repo: string,
): Promise<string | null> {
  // Cached by owner/repo, not (installationId, repo) — on a cache hit this
  // must skip `resolveInstallationId` entirely, not just the mint call,
  // or every cache "hit" would still cost a `listInstallations` fetch.
  const key = cacheKey(owner, repo);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt.getTime() - CACHE_SAFETY_MARGIN_MS > Date.now()) {
    return cached.token;
  }

  const appJwt = signAppJwt(appId, privateKeyPem);
  const installationId = await resolveInstallationId(appJwt, owner);
  if (installationId === null) return null;

  const minted = await mintInstallationToken(appJwt, installationId, owner, repo);
  tokenCache.set(key, minted);
  return minted.token;
}

/** Test-only introspection/reset. */
export function clearInstallationTokenCacheForTests(): void {
  tokenCache.clear();
}

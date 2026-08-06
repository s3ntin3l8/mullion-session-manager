import type { FastifyInstance } from "fastify";
import { eq, isNotNull } from "drizzle-orm";
import { integrations, webhookRegistrations } from "../db/schema.js";
import {
  getInstallationToken,
  clearInstallationTokenCacheForApp,
  signAppJwt,
  listInstallations,
  getAuthenticatedApp,
  computeKeyFingerprint,
  GitHubAppError,
} from "./github-app.js";
import { DecryptionError } from "./encryption.js";
import { GitHubApiError } from "./github.js";

// Single GitHub credential for the whole install (issue #27) — not
// per-project. Device flow (a later phase) yields one user token, so this
// mirrors that: connect once, every project's GitHub widget reads the same
// credential. Stored encrypted at rest via EncryptionService (same
// `*Enc` + service-layer encrypt/decrypt convention as
// `hosts.authTokenEnc` — see src/services/host-registry.ts) when
// DB_ENCRYPTION_KEY is set.

export const GITHUB_PROVIDER = "github";

const GITHUB_API_BASE = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 5_000;
// GitHub's REST API 400s any request with no User-Agent — this identifies
// the app the way its own README does, not a per-install/user value.
const USER_AGENT = "mullion-session-manager";

export class InvalidTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTokenError";
  }
}

// Never includes the token — same "hasToken-only summary" shape as
// HostSummary (host-registry.ts). `deviceFlowAvailable` just reflects
// whether an OAuth App client id is configured (Phase 4), so the frontend
// can show/hide the "Connect with GitHub" button without a second request.
export interface GitHubIntegrationSummary {
  connected: boolean;
  tokenType: "pat" | "oauth" | null;
  login: string | null;
  scopes: string[] | null;
  connectedAt: Date | null;
  deviceFlowAvailable: boolean;
  webhookEnabled: boolean;
  webhookBaseUrl: string;
  webhookRegisteredCount: number;
}

type IntegrationRow = typeof integrations.$inferSelect;

function toSummary(
  app: FastifyInstance,
  row: IntegrationRow | undefined,
): GitHubIntegrationSummary {
  const connected = !!row?.authTokenEnc;
  return {
    connected,
    tokenType: connected ? (row!.tokenType as "pat" | "oauth") : null,
    login: connected ? row!.login : null,
    scopes: connected && row!.scopes ? row!.scopes.split(",").filter(Boolean) : null,
    connectedAt: connected ? row!.connectedAt : null,
    deviceFlowAvailable: app.config.GITHUB_OAUTH_CLIENT_ID.trim() !== "",
    webhookEnabled: row?.webhookEnabled ?? false,
    webhookBaseUrl: app.config.MULLION_WEBHOOK_BASE_URL,
    // #490b — real count read from webhook_registrations (previously
    // hardcoded 0: nothing persisted a per-repo registration count for
    // this to report). Only rows with a live hookId count — a failed
    // attempt or a post-disable cleared row shouldn't inflate this.
    webhookRegisteredCount: app.db
      .select({ id: webhookRegistrations.id })
      .from(webhookRegistrations)
      .where(isNotNull(webhookRegistrations.hookId))
      .all().length,
  };
}

function getRow(app: FastifyInstance): IntegrationRow | undefined {
  const [row] = app.db
    .select()
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .all();
  return row;
}

export function getIntegration(app: FastifyInstance): GitHubIntegrationSummary {
  return toSummary(app, getRow(app));
}

/** Internal use only (services that call the GitHub API on the primary's
 * behalf) — decrypts the stored token. Never send this back over the API. */
export function getToken(app: FastifyInstance): string | null {
  const row = getRow(app);
  if (!row?.authTokenEnc) return null;
  return app.encryption.decryptString(row.authTokenEnc);
}

function getGitHubAppCredentials(
  app: FastifyInstance,
): { appId: string; privateKeyPem: string } | null {
  const row = getRow(app);
  if (!row?.githubAppId || !row?.githubAppPrivateKeyEnc) return null;
  return {
    appId: row.githubAppId,
    privateKeyPem: app.encryption.decryptString(row.githubAppPrivateKeyEnc),
  };
}

export type AppVerificationResult =
  | { status: "verified"; appSlug: string }
  | { status: "rejected"; message: string }
  | { status: "mismatch"; message: string; actualAppId: string }
  | { status: "unreachable"; message: string };

/**
 * #514 — verifies a (appId, privateKey) pair against GitHub's own `GET
 * /app` before `setGitHubApp` ever persists it, so a wrong-App key (valid
 * RSA, parses fine, just isn't *this* App's key) doesn't sit there silently
 * degrading every write to the PAT fallback. Deliberately narrower than
 * `resolveGitHubToken`'s own "any GitHubAppError falls back" posture: only
 * a genuine 401 (GitHub rejected the key/App-id pair outright) or a
 * mismatched `id` in a 200 response block the caller — those are the two
 * outcomes that actually mean "this credential is wrong," not "GitHub is
 * having a bad moment." A 403 (e.g. a secondary rate limit), 404, 5xx, or a
 * network/timeout failure must NOT block a rotation — that's also what
 * keeps the documented re-PUT-to-flush-caches workaround usable while
 * GitHub is unreachable. Left as a standalone async function rather than
 * folded into `setGitHubApp` itself, so `setGitHubApp` stays synchronous —
 * its only caller (the PUT route) awaits this first, then calls the
 * unchanged sync `setGitHubApp`.
 */
export async function verifyAppCredentials(
  appId: string,
  privateKeyPem: string,
): Promise<AppVerificationResult> {
  // Hermes review, PR #519: signAppJwt's own failure is handled in a
  // SEPARATE try/catch from the network call below, not folded into the
  // same one. It never reaches GitHub at all — no HTTP round trip
  // happened, so GitHubAppError.status is undefined exactly like a raw
  // network failure from getAuthenticatedApp below, and the two used to be
  // indistinguishable, both landing on "unreachable" ("GitHub had a bad
  // moment"). But the route already validated the key parses as an RSA
  // PEM before ever calling this function — a signAppJwt failure past that
  // point means the key is locally unusable in some way that check
  // couldn't catch, which is a "this credential is wrong" outcome
  // (`rejected`), not a transient GitHub issue that should persist anyway.
  let appJwt: string;
  try {
    appJwt = signAppJwt(appId, privateKeyPem);
  } catch (err) {
    if (!(err instanceof GitHubAppError)) throw err;
    return { status: "rejected", message: err.message };
  }

  try {
    const authenticated = await getAuthenticatedApp(appJwt);
    if (String(authenticated.id) !== appId) {
      return {
        status: "mismatch",
        message: `This private key belongs to a different App (id ${authenticated.id}, not ${appId}).`,
        actualAppId: String(authenticated.id),
      };
    }
    return { status: "verified", appSlug: authenticated.slug };
  } catch (err) {
    // Same narrowing rationale as resolveGitHubToken's own catch below —
    // an unexpected (non-GitHubAppError) throw is a bug in this function's
    // own code, not an expected "credential might be wrong" outcome, and
    // must not be silently absorbed into a generic "unreachable" result.
    if (!(err instanceof GitHubAppError)) throw err;
    if (err.status === 401) {
      return {
        status: "rejected",
        message: "GitHub rejected this App id/private key pair (HTTP 401).",
      };
    }
    return { status: "unreachable", message: err.message };
  }
}

/** Persists a GitHub App's id + PEM private key, encrypted at rest the same
 * way as authTokenEnc/webhookSecretEnc. Independent of the shared PAT/OAuth
 * token — configuring an App neither requires nor disturbs it. */
export function setGitHubApp(app: FastifyInstance, appId: string, privateKeyPem: string): void {
  // #514 — read the OUTGOING appId before the upsert, same pattern
  // clearGitHubApp already uses below. Without this, changing the
  // configured App from A to B only ever evicted B's cache entries (via
  // the clearInstallationTokenCacheForApp(appId) call after the upsert,
  // where `appId` is always the incoming one) — A's still-cached tokens
  // and installation-id lookups just sat unreachable while B was
  // configured, and would be served again, stale, if an operator swapped
  // back to A within the hour. That A→B→A path is exactly what happens
  // while troubleshooting a botched rotation, so this isn't a corner case.
  const [existing] = app.db
    .select({ githubAppId: integrations.githubAppId })
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .all();
  const outgoingAppId = existing?.githubAppId;

  const githubAppPrivateKeyEnc = app.encryption.encryptString(privateKeyPem);
  // #514 — stamped on every successful configure/rotate, so Settings can
  // show "Key set <date>" and an operator has some signal a rotation
  // actually landed distinct from the (unchanged) appId/installation count.
  const githubAppKeyRotatedAt = new Date();
  app.db
    .insert(integrations)
    .values({
      provider: GITHUB_PROVIDER,
      githubAppId: appId,
      githubAppPrivateKeyEnc,
      githubAppKeyRotatedAt,
    })
    .onConflictDoUpdate({
      target: integrations.provider,
      set: { githubAppId: appId, githubAppPrivateKeyEnc, githubAppKeyRotatedAt },
    })
    .run();
  // Hermes review, PR #504: re-PUTting the SAME appId (e.g. after an
  // uninstall→reinstall on GitHub's side changed the underlying
  // installation id, or a rotated private key) must not keep serving a
  // token/installation-id resolved under the previous configuration for
  // up to an hour.
  clearInstallationTokenCacheForApp(appId);
  clearGitHubAppStatusCacheForApp(appId);
  // #514 — and if the appId itself just changed, the outgoing one's
  // entries need evicting too, not just left to expire on their own.
  if (outgoingAppId && outgoingAppId !== appId) {
    clearInstallationTokenCacheForApp(outgoingAppId);
    clearGitHubAppStatusCacheForApp(outgoingAppId);
  }
}

export function clearGitHubApp(app: FastifyInstance): void {
  // Hermes review, PR #504: read the outgoing appId first so its cached
  // installation tokens can be evicted too — otherwise a still-valid
  // cache entry silently outlives the credentials that produced it (the
  // (appId, owner, repo) cache key already stops a *different* newly
  // configured App from ever reading it, but this clears it outright
  // rather than leaving it to expire on its own within the hour).
  const [row] = app.db
    .select({ githubAppId: integrations.githubAppId })
    .from(integrations)
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .all();
  if (row?.githubAppId) {
    clearInstallationTokenCacheForApp(row.githubAppId);
    clearGitHubAppStatusCacheForApp(row.githubAppId);
  }

  app.db
    .update(integrations)
    .set({ githubAppId: null, githubAppPrivateKeyEnc: null, githubAppKeyRotatedAt: null })
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .run();
}

export interface GitHubAppStatus {
  configured: boolean;
  // Public — a numeric App id, not a secret (the private key never leaves
  // this function). `null` when no App is configured.
  appId: string | null;
  // How many accounts this App is installed on, straight from GitHub's own
  // `/app/installations` list — the same call `resolveGitHubToken` makes
  // to resolve an owner, just for display rather than to mint a token.
  // `null` when not configured, or when the live list call itself failed
  // (logged, not surfaced as an error — this is a status display, not a
  // write path, so a transient GitHub outage shouldn't make the whole
  // integration summary fail to load).
  installationCount: number | null;
  // #514 — a SHA-256/base64 fingerprint of the stored key's public half
  // (see computeKeyFingerprint, github-app.ts), directly comparable to the
  // fingerprint GitHub's own App settings page displays. Not a secret.
  // `null` when not configured, or when the stored key can't be decrypted
  // (e.g. a DB_ENCRYPTION_KEY mismatch) — same tolerance
  // installationCount already has for its own failure mode.
  keyFingerprint: string | null;
  // #514 — when the currently-stored key was last set (initial configure
  // or a rotation), for Settings' "Key set <date>" display. `null` when
  // not configured, or for a row that predates this column.
  keyRotatedAt: Date | null;
}

/**
 * #489 remaining scope — non-secret visibility into whether a GitHub App is
 * configured and how many repos/orgs it's actually installed on, so "an App
 * is configured" isn't just a fact recorded in the database with no way to
 * verify it's doing anything. Deliberately a SEPARATE async function from
 * `getIntegration`/`toSummary` above, not folded into that summary: this
 * makes a live GitHub API call (a real network round trip), and
 * `getIntegration` is called from a hot, synchronous write path
 * (`task-github-sync.ts`'s `runSync`, to read the connected login) where
 * that would add real latency and a new failure mode to something that
 * currently can't fail. Only `routes/integrations.ts`'s `GET
 * /api/integrations/github` handler awaits this, merging it into the
 * response.
 */
// Hermes review, PR #512 — GET /api/integrations/github went from a pure
// sync DB read to a live `listInstallations` network round trip (JWT sign
// + decrypt + fetch) on every call once this function shipped; the
// Settings page refetches on mount and after every change, with no rate
// limit on this endpoint. A short cache means a slow/unreachable GitHub
// can't stall repeated status fetches, and a momentary outage doesn't
// flicker the installation count between a real value and null on every
// poll. Keyed by appId (not a single global slot) so the same
// clearGitHubAppStatusCacheForApp call the token cache already uses on
// reconfigure also invalidates this one — a stale count from a previous
// App config never survives past a genuine change.
const appStatusCache = new Map<string, { installationCount: number | null; expiresAt: number }>();
const APP_STATUS_CACHE_TTL_MS = 60_000;

function clearGitHubAppStatusCacheForApp(appId: string): void {
  appStatusCache.delete(appId);
}

/** Test-only reset. */
export function clearGitHubAppStatusCacheForTests(): void {
  appStatusCache.clear();
}

export async function getGitHubAppStatus(app: FastifyInstance): Promise<GitHubAppStatus> {
  const row = getRow(app);
  if (!row?.githubAppId || !row?.githubAppPrivateKeyEnc) {
    return {
      configured: false,
      appId: null,
      installationCount: null,
      keyFingerprint: null,
      keyRotatedAt: null,
    };
  }
  const appId = row.githubAppId;
  const keyRotatedAt = row.githubAppKeyRotatedAt ?? null;

  // #514 — derived once, up front, from the stored PEM directly. This is
  // its OWN try/catch, separate from the installation-count one below and
  // computed before the cache-hit check — the fingerprint is a pure
  // function of the encrypted column, it has nothing to do with the
  // *network* status cache. Folding it into the installation-count
  // try/catch (or computing it only past the cache-hit return) would mean
  // the cache-hit return site is missing the field, and the obvious fix —
  // typing it null there — makes the value flicker: present right after a
  // rotation, null for the next 60s while the status cache is warm, then
  // present again.
  let keyFingerprint: string | null;
  try {
    keyFingerprint = computeKeyFingerprint(
      app.encryption.decryptString(row.githubAppPrivateKeyEnc),
    );
  } catch (err) {
    app.log.warn({ err }, "[github-integration] could not compute the GitHub App key fingerprint");
    keyFingerprint = null;
  }

  const cached = appStatusCache.get(appId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      configured: true,
      appId,
      installationCount: cached.installationCount,
      keyFingerprint,
      keyRotatedAt,
    };
  }

  try {
    const privateKeyPem = app.encryption.decryptString(row.githubAppPrivateKeyEnc);
    const appJwt = signAppJwt(appId, privateKeyPem);
    const installations = await listInstallations(appJwt);
    appStatusCache.set(appId, {
      installationCount: installations.length,
      expiresAt: Date.now() + APP_STATUS_CACHE_TTL_MS,
    });
    return {
      configured: true,
      appId,
      installationCount: installations.length,
      keyFingerprint,
      keyRotatedAt,
    };
  } catch (err) {
    app.log.warn(
      { err },
      "[github-integration] could not list GitHub App installations for status display",
    );
    // Deliberately not cached — a transient failure shouldn't keep
    // displaying "unknown" for the full TTL once GitHub recovers; the
    // next status fetch just tries again.
    return { configured: true, appId, installationCount: null, keyFingerprint, keyRotatedAt };
  }
}

/**
 * #489 — the repo-scoped resolver every *repo-scoped* GitHub call routes
 * through instead of the plain `getToken` above: an installation token
 * scoped to `repo` (and to `scope`'s permission set) when a GitHub App is
 * configured *and* installed on `owner`, falling back to the shared PAT/
 * OAuth token otherwise (App not configured, App configured but not
 * installed on this particular owner, the mint failing — a transient
 * GitHub outage shouldn't turn into a hard write failure when the PAT
 * would have worked fine — or the installation not having granted the
 * permissions `scope` needs). Originally Task Master's write paths only
 * (`scope: "write"`); the base integration's read-only surfaces (repo-
 * status widget, PR/CI poller) now call this too with `scope: "read"`
 * (#489 remaining scope) — so an App configured for a repo is used
 * consistently for everything Mullion does with that repo, not just
 * autonomous writes. **Deliberately still not used by webhook
 * registration** (`github-webhook.ts`) — a GitHub App doesn't create
 * per-repo hooks, it receives events by installation, which is an
 * architecture difference from a token swap, not something this resolver
 * can paper over — and not by the device flow or `login`/`scopes`
 * display, which are user-identity concepts an installation token has no
 * equivalent for.
 */
export async function resolveGitHubToken(
  app: FastifyInstance,
  repo: { owner: string; repo: string },
  // #489 remaining scope — "write" (the original slice: Task Master's own
  // sync/promote/push) or "read" (the base integration's repo-status
  // widget and PR/CI poller). Two flavors, not one widened token: a single
  // token covering both would hand every Task Master *write* an `actions`
  // scope it has no use for, undermining the least-privilege property
  // #489 shipped for. See github-app.ts's WRITE_PERMISSIONS/READ_PERMISSIONS.
  scope: "write" | "read" = "write",
): Promise<string | null> {
  try {
    // Hermes review, PR #504: the credentials read (which decrypts the
    // stored private key) belongs INSIDE this try, not before it — a
    // decryptString throw (e.g. corrupted ciphertext after a
    // DB_ENCRYPTION_KEY rotation) must fall back to the PAT the same way
    // a mint failure does, not propagate out and violate this function's
    // own "fall back, never hard-fail" contract.
    const appCreds = getGitHubAppCredentials(app);
    if (appCreds) {
      const result = await getInstallationToken(
        appCreds.appId,
        appCreds.privateKeyPem,
        repo.owner,
        repo.repo,
        scope,
      );
      if (result.token) return result.token;
      // Hermes review, PR #504: distinct from the catch below — the App
      // is configured and reachable, it's just not installed on this
      // particular owner. Logged separately (debug, not warn) so an
      // operator can tell "not installed here" apart from "misconfigured
      // or GitHub is down." `installationsChecked` (round 6) lets that
      // operator further tell a genuine non-install apart from the
      // 100-installation page cap (`listInstallations`, github-app.ts)
      // silently truncating the list before this owner was ever checked.
      app.log.debug(
        { owner: repo.owner, repo: repo.repo, installationsChecked: result.installationsChecked },
        "[github-integration] GitHub App has no installation covering this owner — falling back to the shared PAT/OAuth token",
      );
    }
  } catch (err) {
    // Hermes review, PR #504 (round 7): narrowed from a bare catch-all —
    // that also swallowed programming errors (a `TypeError` from a bug in
    // this function's own code, say) into a silent, indefinitely-masked
    // warn log. `GitHubAppError` (github-app.ts — JWT signing, the
    // installations list, the token exchange, all now consistently wrap
    // their own network/HTTP failures into this type), `DecryptionError`
    // (a corrupted/rotated stored private key), and `GitHubApiError`
    // (`validateGitHubRepoRef`'s malformed owner/repo rejection) are this
    // function's own documented, expected "fall back to the PAT" failure
    // modes. Anything else is unexpected and rethrown rather than hidden.
    if (!(
      err instanceof GitHubAppError ||
      err instanceof DecryptionError ||
      err instanceof GitHubApiError
    )) {
      throw err;
    }
    app.log.warn(
      { err, owner: repo.owner, repo: repo.repo },
      "[github-integration] GitHub App installation token mint failed — falling back to the shared PAT/OAuth token",
    );
  }
  return getToken(app);
}

interface GitHubUserValidation {
  login: string;
  scopes: string[];
}

// Validates a token against GitHub's own API rather than trusting the
// caller's input — a malformed or revoked PAT is rejected here, before it's
// ever persisted, rather than surfacing as a mysterious 401 the next time a
// project's GitHub widget tries to use it.
async function validateToken(token: string): Promise<GitHubUserValidation> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_BASE}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": USER_AGENT,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // Unlike RemoteHostClient's SSRF-sensitive `redirect: "manual"` (a
      // user-supplied baseUrl there), this always targets the fixed,
      // trusted api.github.com host — no reason to reject a redirect (e.g.
      // an API mirror/CDN) rather than follow it. Left as "manual" here,
      // a 3xx would leave `res.ok === false` and surface as a misleading
      // "GitHub rejected this token" for a perfectly valid one (Hermes
      // review, PR #38).
    });
  } catch (err) {
    throw new InvalidTokenError(
      `Could not reach GitHub to validate the token: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new InvalidTokenError(`GitHub rejected this token (HTTP ${res.status})`);
  }
  const body = (await res.json()) as { login?: string };
  if (!body.login) {
    throw new InvalidTokenError("Unexpected response from GitHub while validating the token");
  }
  // Fine-grained PATs don't send this header (no OAuth-style scope list) —
  // absent means "unknown," not "no access," so scopes end up null rather
  // than an empty array in that case (see toSummary above).
  const scopesHeader = res.headers.get("x-oauth-scopes");
  const scopes = scopesHeader
    ? scopesHeader
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
  return { login: body.login, scopes };
}

// Shared by setPat and setOAuthToken (Phase 4's device flow) — both end up
// with a validated token and just differ in `tokenType` and (for PAT) in
// having validated it themselves vs. (for OAuth) GitHub's own token
// exchange already having done so.
function storeToken(
  app: FastifyInstance,
  token: string,
  tokenType: "pat" | "oauth",
  login: string,
  scopes: string[],
): GitHubIntegrationSummary {
  const connectedAt = new Date();
  // Encrypted once and reused below (Hermes review, PR #38) — encrypting
  // twice was harmless today, but would silently diverge the insert vs.
  // update value if encryptString's output ever became non-deterministic
  // for the same input.
  const authTokenEnc = app.encryption.encryptString(token);
  app.db
    .insert(integrations)
    .values({
      provider: GITHUB_PROVIDER,
      authTokenEnc,
      tokenType,
      login,
      scopes: scopes.join(","),
      connectedAt,
    })
    .onConflictDoUpdate({
      target: integrations.provider,
      set: {
        authTokenEnc,
        tokenType,
        login,
        scopes: scopes.join(","),
        connectedAt,
      },
    })
    .run();
  return getIntegration(app);
}

export async function setPat(
  app: FastifyInstance,
  token: string,
): Promise<GitHubIntegrationSummary> {
  const { login, scopes } = await validateToken(token);
  return storeToken(app, token, "pat", login, scopes);
}

/** Persists a token GitHub's own device-flow token exchange already handed
 * back as valid (github-device-flow.ts) — still resolves login/scopes via
 * the same GET /user call setPat uses, but skips re-validating a token
 * GitHub itself just issued a moment ago. */
export async function setOAuthToken(
  app: FastifyInstance,
  token: string,
): Promise<GitHubIntegrationSummary> {
  const { login, scopes } = await validateToken(token);
  return storeToken(app, token, "oauth", login, scopes);
}

/**
 * Disconnects the PAT/OAuth token only. Hermes review, PR #504: this used
 * to delete the whole `integrations` row, which silently wiped the
 * independently-configured GitHub App credentials (and webhook config)
 * too — contradicting setGitHubApp's own "configuring an App neither
 * requires nor disturbs [the PAT]" contract in reverse. `toSummary`
 * already treats a row with a null `authTokenEnc` identically to no row
 * at all (`connected: !!row?.authTokenEnc`), so nulling just the PAT
 * columns here is behaviorally equivalent for every existing PAT-facing
 * caller.
 */
export function disconnect(app: FastifyInstance): void {
  app.db
    .update(integrations)
    .set({ authTokenEnc: null, tokenType: null, login: null, scopes: null, connectedAt: null })
    .where(eq(integrations.provider, GITHUB_PROVIDER))
    .run();
}

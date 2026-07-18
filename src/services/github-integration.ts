import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations } from "../db/schema.js";

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
const USER_AGENT = "tessera-session-manager";

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
      redirect: "manual",
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

export async function setPat(
  app: FastifyInstance,
  token: string,
): Promise<GitHubIntegrationSummary> {
  const { login, scopes } = await validateToken(token);
  const connectedAt = new Date();
  app.db
    .insert(integrations)
    .values({
      provider: GITHUB_PROVIDER,
      authTokenEnc: app.encryption.encryptString(token),
      tokenType: "pat",
      login,
      scopes: scopes.join(","),
      connectedAt,
    })
    .onConflictDoUpdate({
      target: integrations.provider,
      set: {
        authTokenEnc: app.encryption.encryptString(token),
        tokenType: "pat",
        login,
        scopes: scopes.join(","),
        connectedAt,
      },
    })
    .run();
  return getIntegration(app);
}

export function disconnect(app: FastifyInstance): void {
  app.db.delete(integrations).where(eq(integrations.provider, GITHUB_PROVIDER)).run();
}

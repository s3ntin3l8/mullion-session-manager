import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, gt, isNull } from "drizzle-orm";
import { automationTokens } from "../db/schema.js";
import { AUTOMATION_TOKEN_SCOPES, type AutomationTokenScope } from "../shared/constants.js";
import type {
  AutomationTokenCreated,
  AutomationTokenState,
  AutomationTokenSummary,
} from "../shared/types.js";
import { timingSafeTokenMatch } from "./crypto-utils.js";

// Issue #3440 — scoped bearer tokens (`mat_<64 hex>`) for automation
// controllers (e.g. Ansible) to mint single-use pairing codes on
// POST /api/host-pairings without holding a reusable enrollment secret.

export const AUTOMATION_TOKEN_PREFIX = "mat_";
export const AUTOMATION_TOKEN_PATTERN = /^mat_[0-9a-f]{64}$/;
export const AUTOMATION_TOKEN_DEFAULT_EXPIRES_DAYS = 90;
export const AUTOMATION_TOKEN_MAX_EXPIRES_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

export type AutomationTokenRow = typeof automationTokens.$inferSelect;

export interface VerifiedAutomationToken {
  id: string;
  label: string;
  scopes: AutomationTokenScope[];
  allowedCidrs: string | null;
  requireApproval: boolean;
}

function sha256Hex(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseScopes(raw: string): AutomationTokenScope[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(AUTOMATION_TOKEN_SCOPES);
    return parsed.filter((s): s is AutomationTokenScope => typeof s === "string" && allowed.has(s));
  } catch {
    return [];
  }
}

function stateOf(row: AutomationTokenRow, nowMs = Date.now()): AutomationTokenState {
  if (row.revokedAt) return "revoked";
  return row.expiresAt.getTime() <= nowMs ? "expired" : "active";
}

function toSummary(row: AutomationTokenRow): AutomationTokenSummary {
  return {
    id: row.id,
    label: row.label,
    scopes: parseScopes(row.scopes),
    expires_at: row.expiresAt.toISOString(),
    allowed_cidrs: row.allowedCidrs,
    require_approval: row.requireApproval,
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    state: stateOf(row),
  };
}

export interface CreateAutomationTokenInput {
  label: string;
  scopes: AutomationTokenScope[];
  expiresInDays?: number;
  allowedCidrs?: string | null;
  requireApproval?: boolean;
}

export function createAutomationToken(
  app: FastifyInstance,
  input: CreateAutomationTokenInput,
): AutomationTokenCreated {
  const id = crypto.randomUUID();
  const token = `${AUTOMATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString("hex")}`;
  const secretHash = sha256Hex(token);
  const days = Math.min(
    AUTOMATION_TOKEN_MAX_EXPIRES_DAYS,
    Math.max(1, Math.trunc(input.expiresInDays ?? AUTOMATION_TOKEN_DEFAULT_EXPIRES_DAYS)),
  );
  const expiresAt = new Date(Date.now() + days * DAY_MS);
  const uniqueScopes = Array.from(new Set(input.scopes));
  const allowedCidrs = input.allowedCidrs?.trim() || null;

  const row = app.db
    .insert(automationTokens)
    .values({
      id,
      label: input.label.trim(),
      secretHash,
      scopes: JSON.stringify(uniqueScopes),
      expiresAt,
      allowedCidrs,
      requireApproval: input.requireApproval ?? false,
    })
    .returning()
    .get();

  return {
    ...toSummary(row),
    token,
  };
}

export function listAutomationTokens(app: FastifyInstance): AutomationTokenSummary[] {
  return app.db
    .select()
    .from(automationTokens)
    .orderBy(desc(automationTokens.createdAt))
    .all()
    .map(toSummary);
}

export function revokeAutomationToken(app: FastifyInstance, id: string): boolean {
  const updated = app.db
    .update(automationTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(automationTokens.id, id), isNull(automationTokens.revokedAt)))
    .returning({ id: automationTokens.id })
    .all();
  return updated.length > 0;
}

/**
 * Extracts the raw `mat_...` bearer token if the Authorization header uses the
 * `Bearer mat_` prefix. Returns null for any other auth scheme or token shape
 * (including `MULLION_AUTH_TOKEN`).
 */
export function extractAutomationBearer(authorizationHeader: string | undefined): string | null {
  if (!authorizationHeader?.startsWith("Bearer ")) return null;
  const candidate = authorizationHeader.slice("Bearer ".length);
  return candidate.startsWith(AUTOMATION_TOKEN_PREFIX) ? candidate : null;
}

/**
 * Looks up a live (unrevoked, unexpired) automation token by its plaintext
 * `mat_...` secret. The token is 256 random bits, so its SHA-256 hash is
 * uniformly distributed and an indexed hash lookup reveals no secret prefix;
 * `timingSafeTokenMatch` is still applied to the matched hash as defense in
 * depth. Returns null for malformed, unknown, revoked, or expired tokens.
 */
export function findLiveAutomationTokenBySecret(
  app: FastifyInstance,
  presentedToken: string,
): VerifiedAutomationToken | null {
  if (!AUTOMATION_TOKEN_PATTERN.test(presentedToken)) return null;
  const presentedHash = sha256Hex(presentedToken);
  const now = new Date();
  const row = app.db
    .select()
    .from(automationTokens)
    .where(
      and(
        eq(automationTokens.secretHash, presentedHash),
        isNull(automationTokens.revokedAt),
        gt(automationTokens.expiresAt, now),
      ),
    )
    .get();
  if (!row || !timingSafeTokenMatch(row.secretHash, presentedHash)) return null;
  if (row.expiresAt.getTime() <= now.getTime()) return null;
  return {
    id: row.id,
    label: row.label,
    scopes: parseScopes(row.scopes),
    allowedCidrs: row.allowedCidrs,
    requireApproval: row.requireApproval,
  };
}

export function touchAutomationTokenLastUsed(app: FastifyInstance, id: string): void {
  app.db
    .update(automationTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(automationTokens.id, id))
    .run();
}

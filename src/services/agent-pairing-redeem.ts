import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PAIRING_CODE_PATTERN } from "../shared/pairing-link.js";
import { identityStatePath, saveAgentIdentity, savePrivateFileAtomic } from "./agent-identity.js";

const PAIRING_REQUEST_FILE = "pairing-request.json";
const DEFAULT_PAIR_TIMEOUT_MS = 15_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_DIGITS = "0123456789abcdef";

export interface RedeemPairingCodeOptions {
  primaryUrl: string;
  code: string;
  sessionsDir: string;
  name?: string;
  advertiseUrl?: string;
  hostname?: string;
  platform?: string;
  timeoutMs?: number;
}

export interface RedeemPairingCodeResult {
  hostId: string;
}

interface PersistedPairingRequest {
  codeHash: string;
  requestId: string;
}

function normalizePrimaryUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid primary URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Primary URL must use http:// or https://");
  }
  return trimmed;
}

function sanitizeUuid(value: unknown): string | null {
  if (typeof value !== "string" || !UUID_RE.test(value)) return null;
  // Reconstruct from the constant hex alphabet so only canonical UUID characters
  // can cross from the local state file into the outbound /api/internal/pair body.
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "-") {
      out += "-";
      continue;
    }
    const idx = HEX_DIGITS.indexOf(ch.toLowerCase());
    if (idx === -1) return null;
    out += HEX_DIGITS[idx]!;
  }
  return out;
}

function loadExistingRequestId(requestPath: string, codeHash: string): string | null {
  try {
    const raw = fs.readFileSync(requestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<PersistedPairingRequest>;
    if (parsed.codeHash === codeHash) {
      return sanitizeUuid(parsed.requestId);
    }
  } catch {
    // Missing or unreadable request file: generate a fresh requestId.
  }
  return null;
}

/**
 * One-shot agent-side pairing redeem:
 * 1. Persists a `requestId` to a 0600 file under `sessionsDir` BEFORE the first
 *    request so a retry after a lost response converges on the same host.
 * 2. Calls `POST /api/internal/pair`.
 * 3. Persists `{hostId, machineCredential}` via `saveAgentIdentity` (overwriting
 *    any existing identity file) and removes the temporary request file.
 *
 * A definitive rejection (HTTP 400/401 — the code is invalid, expired, already
 * used, or the request itself was refused) also removes the request file: the
 * primary will never accept that code, so a later attempt must start with a
 * fresh `requestId`. A transient failure (a timeout, a 5xx, a 429) keeps it, so
 * the retry reuses the same `requestId` and converges on the same host.
 *
 * Never echoes the pairing code or machine credential in errors or return values.
 */
export async function redeemPairingCode(
  opts: RedeemPairingCodeOptions,
): Promise<RedeemPairingCodeResult> {
  const primaryUrl = normalizePrimaryUrl(opts.primaryUrl);
  const code = opts.code.trim();
  if (!PAIRING_CODE_PATTERN.test(code)) {
    throw new Error("Invalid pairing code (expected 64 hex characters)");
  }

  const resolvedSessionsDir = path.resolve(opts.sessionsDir);
  const requestPath = path.join(resolvedSessionsDir, PAIRING_REQUEST_FILE);
  const codeHash = crypto.createHash("sha256").update(code).digest("hex");

  let requestId = loadExistingRequestId(requestPath, codeHash);
  if (!requestId) {
    requestId = crypto.randomUUID();
    await savePrivateFileAtomic(requestPath, JSON.stringify({ codeHash, requestId }));
  }

  const hostname = opts.hostname?.trim() || os.hostname();
  const platform = opts.platform?.trim() || process.platform;
  const name = opts.name?.trim() || undefined;
  const advertiseUrl = opts.advertiseUrl?.trim() || undefined;

  const res = await fetch(`${primaryUrl}/api/internal/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      requestId,
      hostname,
      platform,
      ...(name ? { name } : {}),
      ...(advertiseUrl ? { baseUrl: advertiseUrl } : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS),
    redirect: "manual",
  });

  if (!res.ok) {
    if (res.status === 401) {
      // Definitive: the primary refused the code, so the persisted requestId
      // is stale and must not be reused by a later attempt.
      fs.rmSync(requestPath, { force: true });
      throw new Error(
        "Pairing failed: the pairing code is invalid, expired, or already used (HTTP 401)",
      );
    }
    if (res.status === 400) {
      // Definitive too: the request was refused, not lost.
      fs.rmSync(requestPath, { force: true });
      throw new Error(`Pairing failed with HTTP ${res.status}`);
    }
    if (res.status === 429) {
      // Transient: the rate limiter blocks the address for a while, and the
      // same requestId must be reused once the block passes.
      throw new Error("Pairing failed: too many failed pairing attempts (HTTP 429)");
    }
    if (res.status >= 300 && res.status < 400) {
      // A login gateway in front of the primary (an Authentik forwardAuth, a
      // proxy that demands a session) answers with a redirect instead of the
      // API. The `Location` header is deliberately NOT included: it can carry
      // a session token, and the error must not echo anything the caller did
      // not ask for. The pairing code is not in the message either.
      //
      // Both spellings of the primary's address are named: `install.sh` takes
      // the pairing primary from `MULLION_AGENT_PRIMARY_URL` and only falls
      // back to `MULLION_PRIMARY_URL` read out of an existing `.env`, so an
      // operator who only sets the latter in their shell would hit the same
      // redirect again. The `.env` spelling is what the agent itself reads.
      throw new Error(
        `Pairing failed: the primary answered with a redirect (HTTP ${res.status}), which usually means a login gateway sits in front of it. Use the primary's direct address as MULLION_AGENT_PRIMARY_URL (MULLION_PRIMARY_URL in .env); see docs/multi-host.md`,
      );
    }
    throw new Error(`Pairing failed with HTTP ${res.status}`);
  }

  const json = (await res.json()) as {
    host_id?: unknown;
    machine_credential?: unknown;
  };
  if (
    typeof json.host_id !== "string" ||
    !json.host_id ||
    typeof json.machine_credential !== "string" ||
    !json.machine_credential
  ) {
    throw new Error("Pairing response did not include a valid machine identity");
  }

  const statePath = identityStatePath(resolvedSessionsDir);
  await saveAgentIdentity(statePath, {
    hostId: json.host_id,
    machineCredential: json.machine_credential,
  });
  fs.rmSync(requestPath, { force: true });

  return { hostId: json.host_id };
}

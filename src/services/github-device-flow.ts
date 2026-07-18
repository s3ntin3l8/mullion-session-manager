import type { FastifyInstance } from "fastify";
import { setOAuthToken } from "./github-integration.js";

// GitHub's OAuth device authorization grant (issue #27, phase 4) — lets a
// user connect without ever typing a token into this app. Deliberately an
// OAuth App flow, not a GitHub App: OAuth App device-flow tokens don't
// expire, so there's no refresh-token handling to build; a GitHub App's
// user-to-server token would need that within 8 hours.
//
// The backend, not the browser, holds the device_code and drives the poll
// loop on GitHub's own schedule (`interval`) — the frontend only ever sees
// the user_code/verification_uri to show the user, and polls this app's own
// GET status endpoint (routes/integrations.ts) purely to refresh its UI,
// completely decoupled from the actual GitHub polling cadence below.

const GITHUB_WEB_BASE = "https://github.com";
const REQUEST_TIMEOUT_MS = 5_000;
const USER_AGENT = "tessera-session-manager";
// Read-only access to repos is all this feature needs (issues/PRs/status);
// there's no finer-grained classic OAuth scope than "repo" for that.
const DEVICE_FLOW_SCOPE = "repo";

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceFlowError";
  }
}

export type DeviceFlowStatus = "pending" | "connected" | "expired" | "denied" | "error";

// Never includes device_code — that's this module's own internal secret,
// not something any API response should carry (see the module comment).
export interface DeviceFlowSummary {
  status: DeviceFlowStatus;
  userCode: string;
  verificationUri: string;
  errorMessage?: string;
}

interface DeviceFlowState {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalMs: number;
  expiresAt: number;
  status: DeviceFlowStatus;
  errorMessage?: string;
  timer: ReturnType<typeof setTimeout> | null;
}

// Module-level singleton — at most one device-flow attempt in flight for
// the whole install, matching github-integration.ts's own "one credential
// total" model. Starting a new attempt (another "Connect with GitHub"
// click) supersedes whatever was already pending.
let current: DeviceFlowState | null = null;

function toSummary(state: DeviceFlowState): DeviceFlowSummary {
  return {
    status: state.status,
    userCode: state.userCode,
    verificationUri: state.verificationUri,
    ...(state.errorMessage ? { errorMessage: state.errorMessage } : {}),
  };
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  // Optional in this type (not just in practice) — this is untrusted
  // external JSON, and both are read with a fallback below.
  expires_in?: number;
  interval?: number;
}

export async function startDeviceFlow(app: FastifyInstance): Promise<DeviceFlowSummary> {
  const clientId = app.config.GITHUB_OAUTH_CLIENT_ID.trim();
  if (!clientId) {
    throw new DeviceFlowError("Device flow is not configured (GITHUB_OAUTH_CLIENT_ID is unset)");
  }

  let res: Response;
  try {
    res = await fetch(`${GITHUB_WEB_BASE}/login/device/code`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({ client_id: clientId, scope: DEVICE_FLOW_SCOPE }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new DeviceFlowError(
      `Could not reach GitHub to start device flow: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    throw new DeviceFlowError(`GitHub rejected the device-code request (HTTP ${res.status})`);
  }
  const data = (await res.json()) as DeviceCodeResponse;

  if (current?.timer) clearTimeout(current.timer);
  // Defensive fallbacks (Hermes review, PR #41) — `interval`/`expires_in`
  // come straight from GitHub's JSON; a missing one would otherwise
  // schedule against NaN. 5s/900s match GitHub's own typical defaults.
  current = {
    deviceCode: data.device_code,
    userCode: data.user_code,
    verificationUri: data.verification_uri,
    intervalMs: (data.interval ?? 5) * 1000,
    expiresAt: Date.now() + (data.expires_in ?? 900) * 1000,
    status: "pending",
    timer: null,
  };
  schedulePoll(app);
  return toSummary(current);
}

function schedulePoll(app: FastifyInstance): void {
  if (!current) return;
  current.timer = setTimeout(() => void pollOnce(app), current!.intervalMs);
}

interface AccessTokenResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
  interval?: number;
}

async function pollOnce(app: FastifyInstance): Promise<void> {
  const state = current;
  if (!state || state.status !== "pending") return;

  if (Date.now() >= state.expiresAt) {
    state.status = "expired";
    return;
  }

  const clientId = app.config.GITHUB_OAUTH_CLIENT_ID.trim();
  let res: Response;
  try {
    res = await fetch(`${GITHUB_WEB_BASE}/login/oauth/access_token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: state.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // A transient network blip polling GitHub isn't a real failure of the
    // flow itself — retry on the same schedule rather than surfacing
    // "error" for what's likely a momentary connectivity issue.
    schedulePoll(app);
    return;
  }

  let data: AccessTokenResponse;
  try {
    data = (await res.json()) as AccessTokenResponse;
  } catch {
    schedulePoll(app);
    return;
  }

  if (data.access_token) {
    try {
      await setOAuthToken(app, data.access_token);
      state.status = "connected";
    } catch (err) {
      state.status = "error";
      state.errorMessage = err instanceof Error ? err.message : String(err);
    }
    return;
  }

  switch (data.error) {
    case "authorization_pending":
      schedulePoll(app);
      return;
    case "slow_down":
      // RFC 8628: `interval` here is the new polling interval to use, not
      // a delta to add — treating it as additive would grow the delay
      // without bound across repeated slow_downs and double-count
      // GitHub's own value (Hermes review, PR #41). Falls back to the
      // current interval + 5s (RFC 8628's minimum backoff) if GitHub
      // omits it.
      state.intervalMs = (data.interval ?? Math.ceil(state.intervalMs / 1000) + 5) * 1000;
      schedulePoll(app);
      return;
    case "expired_token":
      state.status = "expired";
      return;
    case "access_denied":
      state.status = "denied";
      return;
    default:
      state.status = "error";
      state.errorMessage = data.error_description ?? data.error ?? "Unknown error from GitHub";
  }
}

export function getDeviceFlowStatus(): DeviceFlowSummary | null {
  return current ? toSummary(current) : null;
}

/** Test-only: triggers exactly one poll synchronously instead of waiting on
 * the real setTimeout schedule. Mirrors agent-detect.ts's
 * clearAgentsCacheForTests pattern for a module-level singleton. */
export async function pollDeviceFlowOnceForTests(app: FastifyInstance): Promise<void> {
  if (current?.timer) clearTimeout(current.timer);
  await pollOnce(app);
}

/** Test-only: the current poll interval, to verify slow_down adjusts it
 * correctly (not exposed via DeviceFlowSummary — callers never need it). */
export function getDeviceFlowIntervalMsForTests(): number | null {
  return current?.intervalMs ?? null;
}

export function resetDeviceFlowForTests(): void {
  if (current?.timer) clearTimeout(current.timer);
  current = null;
}

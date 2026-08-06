import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { integrations } from "../db/schema.js";
import {
  disconnect,
  getIntegration,
  getGitHubAppStatus,
  GITHUB_PROVIDER,
  InvalidTokenError,
  setPat,
  setGitHubApp,
  clearGitHubApp,
  verifyAppCredentials,
} from "../services/github-integration.js";
import {
  DeviceFlowError,
  getDeviceFlowStatus,
  startDeviceFlow,
} from "../services/github-device-flow.js";
import { enableWebhooks, disableWebhooks } from "../services/github-webhook.js";
import { computeKeyFingerprint } from "../services/github-app.js";

interface SetTokenBody {
  token: string;
}

const setTokenSchema = {
  body: {
    type: "object",
    required: ["token"],
    additionalProperties: false,
    properties: {
      token: { type: "string", minLength: 1 },
    },
  },
};

// #489 — independent of the PAT/OAuth token above; configures the
// installation-token path Task Master's own writes prefer when set.
// #514 — DOES now make a live validation call to GitHub (GET /app, via
// verifyAppCredentials below) before persisting: rotation is exactly when a
// silent mismatch matters most, since a wrong-but-valid RSA key would
// otherwise sit there passing local checks while every subsequent write
// quietly (and permanently, until someone reads the server logs) degrades
// to the PAT fallback.
interface SetGitHubAppBody {
  appId: string;
  privateKey: string;
}

const setGitHubAppSchema = {
  body: {
    type: "object",
    required: ["appId", "privateKey"],
    additionalProperties: false,
    properties: {
      appId: { type: "string", minLength: 1 },
      privateKey: { type: "string", minLength: 1 },
    },
  },
};

// No *route-level* auth hook here, same as every other route (settings.ts,
// hosts.ts, projects.ts) — see settings.ts's comment on the two opt-in
// layers (gateway forward-auth and/or this process's own in-process auth,
// issue #19) that protect it instead. This is exactly why the summary this
// route returns never includes the token itself, only
// `connected`/`login`/`scopes` — see GitHubIntegrationSummary in
// services/github-integration.ts.
export async function integrationsRoute(app: FastifyInstance) {
  // No explicit reply.type() here (unlike settings.ts's GET/PATCH) —
  // Fastify already serializes a returned plain object as
  // application/json on its own, and hosts.ts/projects.ts don't set it
  // either. settings.ts's explicit call guards a genuinely free-form
  // string (the session-name pattern); the one free-form-ish field here,
  // `login`, is a GitHub username GitHub itself restricts to
  // alphanumeric/hyphen, not arbitrary user input (Hermes review, PR #38).
  app.get("/api/integrations/github", async () => {
    // #489 remaining scope — githubApp merged in alongside the existing
    // synchronous summary, never inside it (see getGitHubAppStatus's own
    // doc comment for why: this is the one call site that can afford the
    // live GitHub round trip a hot write path can't).
    const summary = getIntegration(app);
    const githubApp = await getGitHubAppStatus(app);
    return { ...summary, githubApp };
  });

  // Rate-limited like GET /api/projects/discover (src/routes/projects.ts) —
  // this also reaches out to api.github.com, so it shouldn't be hammerable.
  app.put<{ Body: SetTokenBody }>(
    "/api/integrations/github/token",
    { schema: setTokenSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      try {
        return await setPat(app, request.body.token);
      } catch (err) {
        if (err instanceof InvalidTokenError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    },
  );

  app.delete("/api/integrations/github", async (_request, reply) => {
    disconnect(app);
    reply.code(204);
  });

  // #489 — GitHub App credentials, independent of the PAT/OAuth token
  // above. `githubApp` (the never-secret status: configured/appId/
  // installationCount/fingerprint) IS surfaced, merged into GET
  // /api/integrations/github's summary — see that handler above (#489
  // remaining scope). This route stays write-only for the key itself, same
  // "never echo secrets back" posture as the token route.
  // #514 — rate-limited like the PAT/webhook routes above: this now makes
  // a live call to api.github.com (verifyAppCredentials), where it
  // previously was a pure DB write.
  app.put<{ Body: SetGitHubAppBody }>(
    "/api/integrations/github/app",
    { schema: setGitHubAppSchema, config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (request, reply) => {
      // Hermes review, PR #504: validate at config time, not on the next
      // write — an unparseable key or malformed id otherwise surfaces only
      // as a repeated warn-logged failure on every subsequent Task Master
      // write (each one paying the full sign/resolve flow before falling
      // back to the PAT), discovered only by reading server logs.
      const { appId, privateKey } = request.body;
      if (!/^\d+$/.test(appId)) {
        return reply.badRequest("appId must be the numeric GitHub App id");
      }
      let parsedKey: crypto.KeyObject;
      try {
        parsedKey = crypto.createPrivateKey(privateKey);
      } catch {
        return reply.badRequest("privateKey is not a valid PEM private key");
      }
      // Hermes review, PR #504: createPrivateKey accepts any key type (EC,
      // Ed25519, ...), but signAppJwt signs with RSA-SHA256 specifically —
      // a non-RSA key would otherwise pass this check and only fail on the
      // next write, silently degrading to the PAT fallback with a warn log.
      if (parsedKey.asymmetricKeyType !== "rsa") {
        return reply.badRequest("privateKey must be an RSA private key (GitHub App keys are RSA)");
      }
      // #514 — live verification against GitHub's own GET /app, on top of
      // the local parse/type checks above. Only a genuine 401 (this key
      // doesn't work) or a 200 with a mismatched App id (this key works,
      // but for a DIFFERENT App) rejects the PUT — see
      // verifyAppCredentials's own doc comment for why everything else
      // (403/404/5xx/network failure) persists instead of blocking.
      const verification = await verifyAppCredentials(appId, privateKey);
      if (verification.status === "rejected" || verification.status === "mismatch") {
        return reply.badRequest(verification.message);
      }
      // Hermes review, PR #519: computed from the plaintext key already in
      // hand (rather than re-decrypting the just-persisted row — a pure
      // function of the same PEM either way) — and deliberately BEFORE
      // setGitHubApp, not after. If this ever threw (near-unreachable now
      // that computeKeyFingerprint wraps its own failures, but not
      // provably impossible), doing it after persisting would strand the
      // App configured while the route 500s and the UI shows a failure for
      // what was actually a successful configure.
      const keyFingerprint = computeKeyFingerprint(privateKey);
      setGitHubApp(app, appId, privateKey);
      if (verification.status === "verified") {
        return { verified: true, appSlug: verification.appSlug, keyFingerprint };
      }
      // "unreachable" — persisted anyway (see verifyAppCredentials), but
      // the caller gets told the credential is still unverified rather
      // than a silent 200 identical to a confirmed-good configure.
      return { verified: false, keyFingerprint, warning: verification.message };
    },
  );

  app.delete("/api/integrations/github/app", async (_request, reply) => {
    clearGitHubApp(app);
    reply.code(204);
  });

  // Kicks off the device authorization grant (Phase 4) — 400s when no
  // GitHub OAuth App client id is configured, same "not available" signal
  // getIntegration()'s deviceFlowAvailable already tells the frontend to
  // hide the button for. Rate-limited like the PAT route above (also
  // reaches out to github.com).
  app.post(
    "/api/integrations/github/device/start",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      try {
        return await startDeviceFlow(app);
      } catch (err) {
        if (err instanceof DeviceFlowError) {
          return reply.badRequest(err.message);
        }
        throw err;
      }
    },
  );

  // Polled by the frontend purely to refresh its own UI — decoupled from
  // the actual GitHub polling cadence, which github-device-flow.ts drives
  // on its own schedule server-side. 404 means no attempt is in progress
  // (never started, or already connected/expired and superseded).
  app.get("/api/integrations/github/device/status", async (_request, reply) => {
    const status = getDeviceFlowStatus();
    if (!status) return reply.notFound();
    return status;
  });

  // Webhook status: reports whether webhooks are enabled and what base URL
  // is configured. The frontend calls this on mount to decide whether to
  // show the enable/disable toggle.
  app.get("/api/integrations/github/webhooks/status", async () => {
    const row = app.db
      .select({
        webhookEnabled: integrations.webhookEnabled,
      })
      .from(integrations)
      .where(eq(integrations.provider, GITHUB_PROVIDER))
      .get();
    return {
      enabled: row?.webhookEnabled ?? false,
      webhookBaseUrl: app.config.MULLION_WEBHOOK_BASE_URL || null,
    };
  });

  // Enable webhooks: auto-registers hooks for every project with a github.com
  // remote via the existing PAT. Returns repo registration counts.
  app.post(
    "/api/integrations/github/webhooks",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (_request, reply) => {
      if (!app.config.MULLION_WEBHOOK_BASE_URL) {
        return reply.badRequest("MULLION_WEBHOOK_BASE_URL must be set to enable webhooks");
      }
      try {
        return await enableWebhooks(app);
      } catch (err) {
        return reply.badRequest(
          `Failed to enable webhooks: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  );

  // Disable webhooks: tears down all registered hooks via the existing PAT.
  app.delete("/api/integrations/github/webhooks", async (_request, reply) => {
    await disableWebhooks(app);
    reply.code(204);
  });
}

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import {
  clearHermesKey,
  getHermesIntegration,
  getHermesKey,
  setHermesKey,
} from "../../src/services/hermes-integration.js";
import {
  buildReviewMessage,
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  requestHermesReview,
  resetHermesReviewState,
  ReviewCooldownError,
  testHermesConnection,
} from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `hermes-review-test-${process.pid}.db`);

const API = "http://192.168.2.6:8643";
const PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/review.md";
const PR = { owner: "acme", repo: "widgets", prNumber: 7 };

function timeoutError() {
  return Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
}

describe("hermes review relay", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // What the Hermes endpoints do — overridable per test.
  let health: () => Promise<Response>;
  let dispatch: (init: RequestInit) => Promise<Response>;
  let promptResponse: () => Promise<Response>;

  beforeAll(async () => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    resetHermesReviewState();
    applySettingsPatch(app, {
      reviewRelay: {
        apiUrl: API,
        model: "hermes-agent",
        promptRepo: "acme/.github",
        promptPath: "review.md",
        cooldownMinutes: 10,
      },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    health = async () => new Response("ok", { status: 200 });
    dispatch = async () => new Response("{}", { status: 200 });
    promptResponse = async () => new Response("REVIEW PROMPT BODY", { status: 200 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return promptResponse();
      if (url === `${API}/health`) return health();
      if (url === `${API}/v1/chat/completions`) return dispatch(init ?? {});
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
  });

  const calls = (suffix: string) =>
    fetchMock.mock.calls.filter(([url]) => String(url).endsWith(suffix));

  describe("key storage", () => {
    it("stores the key and only ever summarizes it", () => {
      expect(getHermesKey(app)).toBe("sekret-key"); // pragma: allowlist secret
      const summary = getHermesIntegration(app);
      expect(summary.hasKey).toBe(true);
      expect(summary.updatedAt).toBeInstanceOf(Date);
      expect(JSON.stringify(summary)).not.toContain("sekret-key");
    });

    it("clearing removes the key", () => {
      clearHermesKey(app);
      expect(getHermesKey(app)).toBeNull();
      expect(getHermesIntegration(app)).toEqual({ hasKey: false, updatedAt: null });
    });

    it("replacing the key overwrites the stored one", () => {
      setHermesKey(app, "second-key"); // pragma: allowlist secret
      expect(getHermesKey(app)).toBe("second-key"); // pragma: allowlist secret
    });
  });

  describe("buildReviewMessage", () => {
    it("matches the workflow's header and appends the prompt", () => {
      const msg = buildReviewMessage("acme", "widgets", 7, "PROMPT");
      expect(msg).toContain("Target: pr #7 in repo acme/widgets");
      expect(msg).toContain("github-code-review skill");
      expect(msg).toContain("scripts/app-token.sh");
      expect(msg).toContain("Do NOT ask the human for secrets.");
      expect(msg).toContain("Honor a maximum of 30 agent turns.");
      expect(msg.endsWith("PROMPT")).toBe(true);
    });
  });

  describe("requestHermesReview", () => {
    it("dispatches: health check, then an authenticated POST carrying the prompt", async () => {
      await requestHermesReview(app, PR);

      expect(calls("/health")).toHaveLength(1);
      const [post] = calls("/v1/chat/completions");
      expect(post).toBeDefined();
      const init = post[1] as RequestInit;
      expect(init.method).toBe("POST");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sekret-key");
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("hermes-agent");
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0].content).toContain("Target: pr #7 in repo acme/widgets");
      expect(body.messages[0].content).toContain("REVIEW PROMPT BODY");
    });

    it("treats a timeout after the health check as accepted-and-running", async () => {
      dispatch = () => Promise.reject(timeoutError());
      await expect(requestHermesReview(app, PR)).resolves.toBeUndefined();
    });

    it("tolerates a trailing slash on the configured URL", async () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: `${API}///` } });
      await requestHermesReview(app, PR);
      expect(calls("/v1/chat/completions")).toHaveLength(1);
    });

    it("fails with HermesUnavailableError when the POST can't connect", async () => {
      dispatch = () => Promise.reject(new Error("connect ECONNREFUSED"));
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
    });

    it("fails with HermesAuthError on 401/403", async () => {
      dispatch = async () => new Response("no", { status: 401 });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesAuthError);
      resetHermesReviewState();
      dispatch = async () => new Response("no", { status: 403 });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesAuthError);
    });

    it("fails with HermesUnavailableError on another error status", async () => {
      dispatch = async () => new Response("boom", { status: 500 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/HTTP 500/);
    });

    it("does not POST when the health check fails", async () => {
      health = () => Promise.reject(new Error("connect timed out"));
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      expect(calls("/v1/chat/completions")).toHaveLength(0);
    });

    it("does not POST when health returns a non-2xx", async () => {
      health = async () => new Response("down", { status: 503 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/unreachable/);
      expect(calls("/v1/chat/completions")).toHaveLength(0);
    });

    it("does not start a cooldown for a failed dispatch", async () => {
      dispatch = () => Promise.reject(new Error("connect ECONNREFUSED"));
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      dispatch = async () => new Response("{}", { status: 200 });
      await expect(requestHermesReview(app, PR)).resolves.toBeUndefined();
    });

    it("fails when the prompt can't be fetched (network and HTTP error)", async () => {
      promptResponse = () => Promise.reject(new Error("dns"));
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/review prompt/);
      promptResponse = async () => new Response("nope", { status: 404 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/HTTP 404/);
      expect(calls("/health")).toHaveLength(0);
    });

    it("caches the prompt across requests", async () => {
      await requestHermesReview(app, PR);
      await requestHermesReview(app, { ...PR, prNumber: 8 });
      expect(fetchMock.mock.calls.filter(([url]) => url === PROMPT_URL)).toHaveLength(1);
    });

    describe("configuration", () => {
      it.each([
        ["no API URL", () => applySettingsPatch(app, { reviewRelay: { apiUrl: "" } })],
        ["no prompt repo", () => applySettingsPatch(app, { reviewRelay: { promptRepo: "" } })],
        ["no key", () => clearHermesKey(app)],
      ])("refuses with %s", async (_label, mutate) => {
        mutate();
        await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesNotConfiguredError);
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("refuses a non-http(s) URL", async () => {
        applySettingsPatch(app, { reviewRelay: { apiUrl: "ftp://192.168.2.6:21" } });
        await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesNotConfiguredError);
      });

      it("refuses a link-local / cloud-metadata URL", async () => {
        applySettingsPatch(app, { reviewRelay: { apiUrl: "http://169.254.169.254" } });
        await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesNotConfiguredError);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe("cooldown", () => {
      it("refuses a repeat request for the same PR with a retry-after", async () => {
        await requestHermesReview(app, PR);
        const err = await requestHermesReview(app, PR).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReviewCooldownError);
        expect((err as ReviewCooldownError).retryAfterSeconds).toBeGreaterThan(0);
        expect((err as ReviewCooldownError).retryAfterSeconds).toBeLessThanOrEqual(600);
        expect(calls("/v1/chat/completions")).toHaveLength(1);
      });

      it("is per PR and case-insensitive on the repo", async () => {
        await requestHermesReview(app, PR);
        await expect(requestHermesReview(app, { ...PR, prNumber: 8 })).resolves.toBeUndefined();
        await expect(
          requestHermesReview(app, { owner: "ACME", repo: "Widgets", prNumber: 7 }),
        ).rejects.toBeInstanceOf(ReviewCooldownError);
      });

      it("expires after the configured window", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          await requestHermesReview(app, PR);
          vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
          await expect(requestHermesReview(app, PR)).resolves.toBeUndefined();
        } finally {
          vi.useRealTimers();
        }
      });

      it("is disabled by a 0-minute cooldown", async () => {
        applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
        await requestHermesReview(app, PR);
        await expect(requestHermesReview(app, PR)).resolves.toBeUndefined();
      });
    });
  });

  describe("testHermesConnection", () => {
    it("passes when /health is OK (no key needed)", async () => {
      clearHermesKey(app);
      await expect(testHermesConnection(app)).resolves.toBeUndefined();
    });

    it("fails when no URL is set", async () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: "" } });
      await expect(testHermesConnection(app)).rejects.toBeInstanceOf(HermesNotConfiguredError);
    });

    it("fails when the server is down", async () => {
      health = () => Promise.reject(new Error("connect timed out"));
      await expect(testHermesConnection(app)).rejects.toBeInstanceOf(HermesUnavailableError);
    });
  });
});

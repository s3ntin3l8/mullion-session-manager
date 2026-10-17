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
  BUILTIN_REVIEW_PROMPT,
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  isValidPromptLocation,
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
        provider: "hermes",
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
    it("builds a generic header requiring a bot identity, then appends the prompt", () => {
      const msg = buildReviewMessage("acme", "widgets", 7, "PROMPT");
      expect(msg).toContain("Target: pr #7 in repo acme/widgets");
      expect(msg).toContain("GitHub App bot identity");
      expect(msg).toContain("never with a personal user token");
      expect(msg).not.toContain("app-token.sh");
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

    it("uses the built-in prompt without fetching when no prompt repo is set", async () => {
      applySettingsPatch(app, { reviewRelay: { promptRepo: "" } });
      await requestHermesReview(app, PR);
      expect(fetchMock.mock.calls.some(([url]) => url === PROMPT_URL)).toBe(false);
      const post = fetchMock.mock.calls.find(([url]) =>
        String(url).endsWith("/v1/chat/completions"),
      );
      const content = JSON.parse(String(post![1].body)).messages[0].content as string;
      expect(content).toContain(BUILTIN_REVIEW_PROMPT);
    });

    describe("configuration", () => {
      it.each([
        ["no API URL", () => applySettingsPatch(app, { reviewRelay: { apiUrl: "" } })],
        ["provider none", () => applySettingsPatch(app, { reviewRelay: { provider: "none" } })],
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

  describe("review fixes", () => {
    it("never puts the configured URL in an error a session can see", async () => {
      health = () => Promise.reject(new Error(`connect ECONNREFUSED ${API}`));
      const err = (await requestHermesReview(app, PR).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(HermesUnavailableError);
      expect(err.message).not.toContain("192.168.2.6");
      expect((err as HermesUnavailableError).detail).toContain("192.168.2.6");
    });

    it("hides the URL for a dispatch connection failure too", async () => {
      dispatch = () => Promise.reject(new Error(`connect ECONNREFUSED ${API}`));
      const err = (await requestHermesReview(app, PR).catch((e: unknown) => e)) as Error;
      expect(err.message).not.toContain("192.168.2.6");
    });

    it("the operator-only connection test still shows the URL", async () => {
      health = () => Promise.reject(new Error("connect timed out"));
      await expect(testHermesConnection(app)).rejects.toThrow(/192\.168\.2\.6/);
    });

    it("fetches the prompt without following redirects", async () => {
      await requestHermesReview(app, PR);
      const [, init] = fetchMock.mock.calls.find(([url]) => url === PROMPT_URL)!;
      expect((init as RequestInit).redirect).toBe("error");
    });

    it("refuses an oversized prompt", async () => {
      promptResponse = async () => new Response("x".repeat(200_001), { status: 200 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/too large/);
      expect(calls("/health")).toHaveLength(0);
    });

    it.each([
      ["owner/repo/extra", "p.md"],
      ["owner", "p.md"],
      ["../etc", "p.md"],
      ["owner/repo", "../secret.md"],
      ["owner/repo", "a/../b.md"],
      ["owner/repo", "p.md?x=1"],
      ["owner/repo", "p.md#frag"],
      ["owner/re po", "p.md"],
    ])("rejects an invalid prompt location %s %s", async (promptRepo, promptPath) => {
      expect(isValidPromptLocation(promptRepo, promptPath)).toBe(false);
      applySettingsPatch(app, { reviewRelay: { promptRepo, promptPath } });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesNotConfiguredError);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("accepts a normal nested prompt path", () => {
      expect(isValidPromptLocation("s3ntin3l8/.github", "prompts/hermes-review-prompt.md")).toBe(
        true,
      );
    });

    it("bounds the prompt by bytes read, not by what's forwarded (streamed body)", async () => {
      let pulled = 0;
      const chunk = new Uint8Array(50_000).fill(120);
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          controller.enqueue(chunk);
          if (pulled > 100) controller.close();
        },
      });
      promptResponse = async () => new Response(stream, { status: 200 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/too large/);
      // Stopped reading shortly after the 200KB cap, not the whole stream.
      expect(pulled).toBeLessThan(10);
    });

    it("keeps the API's own error text as server-side detail for a rejected dispatch", async () => {
      dispatch = async () => new Response('{"error":"model not found: nope"}', { status: 400 });
      const err = (await requestHermesReview(app, PR).catch(
        (e: unknown) => e,
      )) as HermesUnavailableError;
      expect(err).toBeInstanceOf(HermesUnavailableError);
      expect(err.message).toContain("HTTP 400");
      expect(err.message).not.toContain("model not found");
      expect(err.detail).toContain("model not found: nope");
    });

    it("only one of two concurrent requests for the same PR dispatches", async () => {
      const results = await Promise.allSettled([
        requestHermesReview(app, PR),
        requestHermesReview(app, PR),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(ReviewCooldownError);
      expect(calls("/v1/chat/completions")).toHaveLength(1);
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

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
  assertReviewerConfigured,
  getHermesReviewStatus,
  getReviewRunForPr,
  listHermesReviews,
  ReviewConflictError,
  ReviewRunForbiddenError,
  ReviewRunNotFoundError,
  stopHermesReview,
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
const PR = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc1234" };

const accepted = (runId = "run_1") =>
  new Response(JSON.stringify({ run_id: runId, status: "queued" }), { status: 202 });

describe("hermes review relay", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // What the Hermes endpoints do — overridable per test.
  let health: () => Promise<Response>;
  let dispatch: (init: RequestInit) => Promise<Response>;
  // GET/POST /v1/runs/<id>[/stop] — the status and stop endpoints.
  let runEndpoint: (url: string, init: RequestInit) => Promise<Response>;
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
    dispatch = async () => accepted();
    runEndpoint = async () => new Response("{}", { status: 404 });
    promptResponse = async () => new Response("REVIEW PROMPT BODY", { status: 200 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return promptResponse();
      if (url === `${API}/health`) return health();
      if (url === `${API}/v1/runs`) return dispatch(init ?? {});
      if (url.startsWith(`${API}/v1/runs/`)) return runEndpoint(url, init ?? {});
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
      const [post] = calls("/v1/runs");
      expect(post).toBeDefined();
      const init = post[1] as RequestInit;
      expect(init.method).toBe("POST");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer sekret-key");
      expect(headers["Idempotency-Key"]).toMatch(/^mullion-review:acme\/widgets#7@abc1234:\d+$/);
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("hermes-agent");
      expect(body.input).toContain("Target: pr #7 in repo acme/widgets");
      expect(body.input).toContain("REVIEW PROMPT BODY");
    });

    it("retries within the cooldown window reuse the key; a later request gets a new one", async () => {
      const keyOf = (i: number) =>
        (fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/v1/runs"))[i][1] as RequestInit)
          .headers as Record<string, string>;
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        dispatch = () => Promise.reject(new Error("connect ECONNREFUSED"));
        await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
        dispatch = async () => accepted();
        await requestHermesReview(app, PR); // the retry
        expect(keyOf(1)["Idempotency-Key"]).toBe(keyOf(0)["Idempotency-Key"]);
        vi.setSystemTime(Date.now() + 11 * 60_000); // past the 10-minute window
        await requestHermesReview(app, PR);
        expect(keyOf(2)["Idempotency-Key"]).not.toBe(keyOf(1)["Idempotency-Key"]);
      } finally {
        vi.useRealTimers();
      }
    });

    it("returns the run id Hermes assigned and indexes it for the PR", async () => {
      dispatch = async () => accepted("run_abc");
      await expect(requestHermesReview(app, { ...PR, sessionId: 5 })).resolves.toEqual({
        runId: "run_abc",
        status: "queued",
        replayed: false,
      });
      expect(getReviewRunForPr("ACME", "Widgets", 7)).toMatchObject({
        runId: "run_abc",
        headSha: "abc1234",
        sessionId: 5,
      });
    });

    it("treats a timeout on the POST as a failure and frees the cooldown slot", async () => {
      dispatch = () =>
        Promise.reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      dispatch = async () => accepted();
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
    });

    it("fails when Hermes answers 202 without a run id", async () => {
      dispatch = async () => new Response("{}", { status: 202 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/no run id/);
      dispatch = async () => new Response("not json", { status: 202 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/no run id/);
    });

    it("maps a 409 idempotency conflict to ReviewConflictError", async () => {
      dispatch = async () =>
        new Response('{"error":{"code":"idempotency_key_conflict"}}', { status: 409 });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(ReviewConflictError);
    });

    it("does not call any other 409 (ownership/identity refusal, odd body) a pending review", async () => {
      for (const body of ['{"error":{"code":"permission_denied"}}', "not json", "{}"]) {
        resetHermesReviewState();
        dispatch = async () => new Response(body, { status: 409 });
        const err = await requestHermesReview(app, PR).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(HermesUnavailableError);
        expect(err).not.toBeInstanceOf(ReviewConflictError);
        expect((err as Error).message).toContain("HTTP 409");
      }
    });

    it("flags a replayed run (Idempotency-Replayed) so callers know nothing new started", async () => {
      dispatch = async () =>
        new Response('{"run_id":"run_old","status":"completed"}', {
          status: 202,
          headers: { "Idempotency-Replayed": "true" },
        });
      await expect(requestHermesReview(app, PR)).resolves.toEqual({
        runId: "run_old",
        status: "completed",
        replayed: true,
      });
      resetHermesReviewState();
      dispatch = async () => accepted();
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ replayed: false });
    });

    it("gives every request a fresh key when the cooldown is disabled", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      await requestHermesReview(app, PR);
      await requestHermesReview(app, PR);
      const keys = fetchMock.mock.calls
        .filter(([u]) => String(u).endsWith("/v1/runs"))
        .map(
          ([, init]) =>
            (init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"],
        );
      expect(keys).toHaveLength(2);
      expect(keys[0]).not.toBe(keys[1]);
    });

    it("passes Retry-After through on 429/503 from Hermes", async () => {
      dispatch = async () =>
        new Response("busy", { status: 429, headers: { "Retry-After": "30" } });
      const err = (await requestHermesReview(app, PR).catch(
        (e: unknown) => e,
      )) as HermesUnavailableError;
      expect(err).toBeInstanceOf(HermesUnavailableError);
      expect(err.retryAfterSeconds).toBe(30);
    });

    it("tolerates a trailing slash on the configured URL", async () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: `${API}///` } });
      await requestHermesReview(app, PR);
      expect(calls("/v1/runs")).toHaveLength(1);
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
      expect(calls("/v1/runs")).toHaveLength(0);
    });

    it("does not POST when health returns a non-2xx", async () => {
      health = async () => new Response("down", { status: 503 });
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/unreachable/);
      expect(calls("/v1/runs")).toHaveLength(0);
    });

    it("does not start a cooldown for a failed dispatch", async () => {
      dispatch = () => Promise.reject(new Error("connect ECONNREFUSED"));
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      dispatch = async () => accepted();
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
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
      const post = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/v1/runs"));
      const content = JSON.parse(String(post![1].body)).input as string;
      expect(content).toContain(BUILTIN_REVIEW_PROMPT);
    });

    it("assertReviewerConfigured says no reviewer for provider none, and returns the key otherwise", () => {
      expect(assertReviewerConfigured(app)).toBe("sekret-key"); // pragma: allowlist secret
      applySettingsPatch(app, { reviewRelay: { provider: "none" } });
      expect(() => assertReviewerConfigured(app)).toThrow(/No reviewer is configured/);
    });

    it("pins the review body shape in the built-in prompt", () => {
      expect(BUILTIN_REVIEW_PROMPT).toContain("**Verdict:**");
      expect(BUILTIN_REVIEW_PROMPT).toContain("### Critical");
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
      it("refuses a repeat request for the same commit with a retry-after", async () => {
        await requestHermesReview(app, PR);
        const err = await requestHermesReview(app, PR).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(ReviewCooldownError);
        expect((err as ReviewCooldownError).retryAfterSeconds).toBeGreaterThan(0);
        expect((err as ReviewCooldownError).retryAfterSeconds).toBeLessThanOrEqual(600);
        expect(calls("/v1/runs")).toHaveLength(1);
      });

      it("names the commit it is throttling", async () => {
        await requestHermesReview(app, PR);
        const err = await requestHermesReview(app, PR).catch((e: unknown) => e);
        expect((err as Error).message).toContain("abc123");
      });

      it("is per commit: a new head SHA is reviewed right away (#1703)", async () => {
        await requestHermesReview(app, PR);
        // A new commit on the same PR is a different review — the cooldown
        // must not hold it back.
        await expect(
          requestHermesReview(app, { ...PR, headSha: "def5678" }),
        ).resolves.toMatchObject({ runId: "run_1" });
        expect(calls("/v1/runs")).toHaveLength(2);
      });

      it("is per commit and case-insensitive on the repo", async () => {
        await requestHermesReview(app, PR);
        await expect(requestHermesReview(app, { ...PR, prNumber: 8 })).resolves.toMatchObject({
          runId: "run_1",
        });
        // The same commit on the same PR, whatever the repo's casing.
        await expect(
          requestHermesReview(app, {
            owner: "ACME",
            repo: "Widgets",
            prNumber: 7,
            headSha: PR.headSha.toUpperCase(),
          }),
        ).rejects.toBeInstanceOf(ReviewCooldownError);
      });

      it("expires after the configured window", async () => {
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          await requestHermesReview(app, PR);
          vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
          await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("is disabled by a 0-minute cooldown", async () => {
        applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
        await requestHermesReview(app, PR);
        await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
      });
    });
  });

  describe("run status, list and stop", () => {
    const run = (over: Record<string, unknown>) =>
      new Response(JSON.stringify({ object: "hermes.run", run_id: "run_1", ...over }), {
        status: 200,
      });

    it("reports not_found when no run is tracked for the PR", async () => {
      await expect(getHermesReviewStatus(app, PR)).resolves.toMatchObject({
        provider: "hermes",
        status: "not_found",
      });
      expect(calls("/v1/runs/run_1")).toHaveLength(0);
    });

    it("returns Hermes' status, bounded output, error and shutdown flag", async () => {
      await requestHermesReview(app, PR);
      runEndpoint = async (url, init) => {
        expect(url).toBe(`${API}/v1/runs/run_1`);
        expect(init.method).toBe("GET");
        return run({
          status: "completed",
          output: "x".repeat(10_000),
          error: "",
          shutdown_requested_at: 1,
        });
      };
      const status = await getHermesReviewStatus(app, PR);
      expect(status).toMatchObject({
        provider: "hermes",
        runId: "run_1",
        status: "completed",
        shuttingDown: true,
        headSha: "abc1234",
        repo: "acme/widgets",
      });
      expect((status as { output: string }).output).toHaveLength(4_000);
      expect((status as { error?: string }).error).toBeUndefined();
    });

    it("maps an expired run (404) to not_found but keeps the run's identity", async () => {
      await requestHermesReview(app, PR);
      await expect(getHermesReviewStatus(app, PR)).resolves.toMatchObject({
        runId: "run_1",
        status: "not_found",
      });
    });

    it("reports an unreadable 200 as unknown, not as an expired run", async () => {
      await requestHermesReview(app, PR);
      runEndpoint = async () => new Response("<html>bad gateway</html>", { status: 200 });
      await expect(getHermesReviewStatus(app, PR)).resolves.toMatchObject({
        runId: "run_1",
        status: "unknown",
      });
    });

    it("fails status with Unavailable on a Hermes 500 and Auth on 401", async () => {
      await requestHermesReview(app, PR);
      runEndpoint = async () => new Response("boom", { status: 500 });
      await expect(getHermesReviewStatus(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      runEndpoint = async () => new Response("no", { status: 401 });
      await expect(getHermesReviewStatus(app, PR)).rejects.toBeInstanceOf(HermesAuthError);
    });

    it("lists recent runs newest first, degrading to unknown when one can't be read", async () => {
      dispatch = async () => accepted("run_a");
      await requestHermesReview(app, PR);
      dispatch = async () => accepted("run_b");
      await requestHermesReview(app, { ...PR, prNumber: 8 });
      runEndpoint = async (url) =>
        url.endsWith("run_a")
          ? new Response("boom", { status: 500 })
          : run({ run_id: "run_b", status: "running" });
      const runs = await listHermesReviews(app);
      expect(runs.map((r) => [r.runId, r.status])).toEqual([
        ["run_b", "running"],
        ["run_a", "unknown"],
      ]);
    });

    it("evicts the oldest runs beyond the tracking cap", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      for (let i = 0; i < 205; i += 1) {
        dispatch = async () => accepted(`run_${i}`);
        await requestHermesReview(app, { ...PR, prNumber: i + 1 });
      }
      expect(getReviewRunForPr("acme", "widgets", 1)).toBeNull();
      expect(getReviewRunForPr("acme", "widgets", 205)?.runId).toBe("run_204");
    });

    it("stops a tracked run (operator, no session)", async () => {
      await requestHermesReview(app, { ...PR, sessionId: 5 });
      runEndpoint = async (url, init) => {
        expect(url).toBe(`${API}/v1/runs/run_1/stop`);
        expect(init.method).toBe("POST");
        return new Response('{"run_id":"run_1","status":"stopping"}', { status: 200 });
      };
      await expect(stopHermesReview(app, "run_1")).resolves.toEqual({
        runId: "run_1",
        status: "stopping",
      });
    });

    it("keeps the original owner when a replay returns an already-tracked run id", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      await requestHermesReview(app, { ...PR, sessionId: 5 });
      const firstDispatchedAt = getReviewRunForPr("acme", "widgets", 7)?.dispatchedAt;
      await new Promise((r) => setTimeout(r, 5));
      await requestHermesReview(app, { ...PR, sessionId: 6 }); // Hermes replays run_1
      expect(getReviewRunForPr("acme", "widgets", 7)?.sessionId).toBe(5);
      expect(getReviewRunForPr("acme", "widgets", 7)?.dispatchedAt).toBe(firstDispatchedAt);
      runEndpoint = async () => new Response('{"status":"stopping"}', { status: 200 });
      await expect(stopHermesReview(app, "run_1", 6)).rejects.toBeInstanceOf(
        ReviewRunForbiddenError,
      );
    });

    it("lets a session stop only its own run", async () => {
      await requestHermesReview(app, { ...PR, sessionId: 5 });
      runEndpoint = async () => new Response('{"status":"stopping"}', { status: 200 });
      await expect(stopHermesReview(app, "run_1", 6)).rejects.toBeInstanceOf(
        ReviewRunForbiddenError,
      );
      await expect(stopHermesReview(app, "run_1", 5)).resolves.toMatchObject({
        status: "stopping",
      });
    });

    it("refuses an unknown run without calling Hermes, and maps a Hermes 404", async () => {
      await expect(stopHermesReview(app, "run_nope")).rejects.toBeInstanceOf(
        ReviewRunNotFoundError,
      );
      expect(calls("/stop")).toHaveLength(0);
      await requestHermesReview(app, PR);
      await expect(stopHermesReview(app, "run_1")).rejects.toBeInstanceOf(ReviewRunNotFoundError);
    });

    it("fails stop with Unavailable on a Hermes 500", async () => {
      await requestHermesReview(app, PR);
      runEndpoint = async () => new Response("boom", { status: 500 });
      await expect(stopHermesReview(app, "run_1")).rejects.toBeInstanceOf(HermesUnavailableError);
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
      expect(calls("/v1/runs")).toHaveLength(1);
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

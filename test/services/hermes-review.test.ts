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
  getRelayStatus,
  getReviewRunForPr,
  getRunForTarget,
  listHermesReviews,
  ReviewConflictError,
  ReviewRunForbiddenError,
  ReviewRunNotFoundError,
  stopHermesReview,
  buildRelayMessage,
  TRIAGE_COMMENT_MARKER,
  BUILTIN_REVIEW_PROMPT,
  BUILTIN_TRIAGE_PROMPT,
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  isValidPromptLocation,
  requestHermesReview,
  requestRelay,
  resetHermesReviewState,
  cooldownEntryCount,
  ReviewAlreadyLandedError,
  ReviewCooldownError,
  ReviewInFlightError,
  reviewIdempotencyKey,
  reviewSessionId,
  testHermesConnection,
} from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `hermes-review-test-${process.pid}.db`);

const API = "http://192.168.2.6:8643";
const PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/review.md";
const TRIAGE_PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/triage.md";
const PR = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc1234" };
const ISSUE = { kind: "issue" as const, owner: "acme", repo: "widgets", number: 7 };

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
  // The check runs on a commit — the in-flight marker (issue #1751, #1757).
  let checkRuns: () => Promise<Response>;
  let createCheckRun: (init: RequestInit) => Promise<Response>;

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
    checkRuns = async () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
    createCheckRun = async () => new Response(JSON.stringify({ id: 4242 }), { status: 201 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return promptResponse();
      if (url === TRIAGE_PROMPT_URL) return promptResponse();
      if (url === `${API}/health`) return health();
      if (url === `${API}/v1/runs`) return dispatch(init ?? {});
      if (url.startsWith(`${API}/v1/runs/`)) return runEndpoint(url, init ?? {});
      if (url.includes("/commits/") && url.includes("/check-runs")) return checkRuns();
      if (url === "https://api.github.com/repos/acme/widgets/check-runs") {
        return createCheckRun(init ?? {});
      }
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

  describe("buildRelayMessage", () => {
    it("builds a generic header requiring a bot identity, then appends the prompt", () => {
      const msg = buildRelayMessage("pull_request", "acme", "widgets", 7, "PROMPT");
      expect(msg).toContain("Target: pr #7 in repo acme/widgets");
      expect(msg).toContain("GitHub App bot identity");
      expect(msg).toContain("never with a personal user token");
      expect(msg).not.toContain("app-token.sh");
      expect(msg).toContain("Do NOT ask the human for secrets.");
      expect(msg).toContain("Honor a maximum of 30 agent turns.");
      expect(msg.endsWith("PROMPT")).toBe(true);
    });

    it("names an issue target as an issue, not a pr (#1629)", () => {
      const msg = buildRelayMessage("issue", "acme", "widgets", 7, "PROMPT");
      expect(msg).toContain("Target: issue #7 in repo acme/widgets");
      expect(msg).not.toContain("Target: pr #7");
      expect(msg.endsWith("PROMPT")).toBe(true);
    });

    it("asks for the comment heading the route matches the triage on (#1629)", () => {
      // The route prefers a comment carrying this marker over another bot's;
      // if the prompt stopped asking for it, that match would silently
      // degrade to the fallback.
      expect(BUILTIN_TRIAGE_PROMPT).toContain(TRIAGE_COMMENT_MARKER);
    });

    it("asks a triage to post a comment, not a review (#1629)", () => {
      // A triage has no verdict to submit — telling it to "post the review"
      // would ask for one.
      const triage = buildRelayMessage("issue", "acme", "widgets", 7, "PROMPT");
      expect(triage).toContain("Post the comment as your GitHub App bot identity");
      expect(triage).not.toContain("Post the review as");
      const review = buildRelayMessage("pull_request", "acme", "widgets", 7, "PROMPT");
      expect(review).toContain("Post the review as your GitHub App bot identity");
    });
  });

  describe("issue triage (#1629)", () => {
    it("dispatches an issue triage with the triage prompt and target", async () => {
      applySettingsPatch(app, {
        reviewRelay: { triagePromptRepo: "acme/.github", triagePromptPath: "triage.md" },
      });
      await requestRelay(app, ISSUE);

      const [post] = calls("/v1/runs");
      const init = post[1] as RequestInit;
      const body = JSON.parse(init.body as string) as { input: string };
      expect(body.input).toContain("Target: issue #7 in repo acme/widgets");
      expect(body.input).toContain("REVIEW PROMPT BODY");
      expect(fetchMock).toHaveBeenCalledWith(TRIAGE_PROMPT_URL, expect.anything());
    });

    it("falls back to the built-in triage prompt", async () => {
      applySettingsPatch(app, {
        reviewRelay: { triagePromptRepo: "", triagePromptPath: "triage.md" },
      });
      await requestRelay(app, ISSUE);
      const [post] = calls("/v1/runs");
      const init = post[1] as RequestInit;
      const body = JSON.parse(init.body as string) as { input: string };
      expect(body.input).toContain("## Triage");
      expect(body.input).toContain(BUILTIN_TRIAGE_PROMPT.trim().slice(0, 40));
    });

    it("uses its own idempotency key namespace", async () => {
      await requestRelay(app, ISSUE);
      const [post] = calls("/v1/runs");
      const init = post[1] as RequestInit;
      const headers = init.headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toContain("mullion-triage:acme/widgets#7");
    });

    it("keeps a triage and a review of the same number apart", async () => {
      // Distinct run ids, as Hermes assigns — a replayed run id means the
      // SAME request, so two targets never share one.
      dispatch = async () => accepted("run_triage");
      await requestRelay(app, ISSUE);
      dispatch = async () => accepted("run_review");
      await requestHermesReview(app, PR);
      // Same number, different kinds — each has its own run, and neither
      // displaces the other in the run index.
      expect(getRunForTarget("issue", "acme", "widgets", 7)).toMatchObject({ kind: "issue" });
      expect(getRunForTarget("pull_request", "acme", "widgets", 7)).toMatchObject({
        kind: "pull_request",
      });
    });

    it("throttles a repeat triage of the same issue, but not a review of a PR with that number", async () => {
      await requestRelay(app, ISSUE);
      const err = await requestRelay(app, ISSUE).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ReviewCooldownError);
      expect((err as Error).message).toContain("triage");
      // A review of PR #7 is a different target — it is not throttled.
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
    });

    it("reports the triage's status under its own kind", async () => {
      dispatch = async () => accepted("run_triage");
      runEndpoint = async () =>
        new Response(JSON.stringify({ status: "running" }), { status: 200 });
      await requestRelay(app, ISSUE);
      const status = await getRelayStatus(app, ISSUE);
      expect(status).toMatchObject({ kind: "issue", status: "running" });
      const missing = await getRelayStatus(app, { ...ISSUE, number: 99 });
      expect(missing).toMatchObject({ status: "not_found", kind: "issue" });
    });

    it("rejects an invalid triage prompt location", async () => {
      applySettingsPatch(app, {
        reviewRelay: { triagePromptRepo: "acme/../evil", triagePromptPath: "triage.md" },
      });
      await expect(requestRelay(app, ISSUE)).rejects.toBeInstanceOf(HermesNotConfiguredError);
    });
  });

  describe("the review protocol (issue #1749)", () => {
    // The shared workflow (s3ntin3l8/.github) derives the session id and the
    // key with the same rules, from the same inputs — the literals below are
    // what both sides must agree on, or the two entry points stop
    // deduplicating against each other.
    it("names a session per pull request, with only safe characters in it", () => {
      expect(reviewSessionId("acme", "widgets", 7)).toBe("hermes-review-acme-widgets-7");
      // A session id becomes a file name on Hermes' side: a "/" or a ".." in it
      // would be rejected as an unsafe session id.
      expect(reviewSessionId("acme", "group/widgets", 7)).toBe(
        "hermes-review-acme-group-widgets-7",
      );
      expect(reviewSessionId("acme", "wid..gets", 7)).toBe("hermes-review-acme-wid--gets-7");
    });

    it("names the idempotency key after the review range", () => {
      expect(reviewIdempotencyKey("acme", "widgets", 7, "base123", "head456")).toBe(
        "hermes-review:acme/widgets#7@base123..head456",
      );
      // The first round of a PR has no base: the range is empty on the left.
      expect(reviewIdempotencyKey("acme", "widgets", 7, undefined, "head456")).toBe(
        "hermes-review:acme/widgets#7@..head456",
      );
    });

    it("dispatches in that session, so the rounds of a PR keep their history", async () => {
      await requestHermesReview(app, PR);
      const [, init] = calls("/v1/runs")[0];
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.session_id).toBe("hermes-review-acme-widgets-7");
    });

    it("refuses a second request while a review of the PR is still running", async () => {
      dispatch = async () => accepted("run_live");
      runEndpoint = async () =>
        new Response(JSON.stringify({ run_id: "run_live", status: "running" }), { status: 200 });
      await requestHermesReview(app, PR);
      const posts = calls("/v1/runs").length;

      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(ReviewInFlightError);
      // No second dispatch: the refusal IS the answer (wait for the run).
      expect(calls("/v1/runs")).toHaveLength(posts);
    });

    it("says which run is already working, so the caller can wait for it", async () => {
      dispatch = async () => accepted("run_live");
      runEndpoint = async () =>
        new Response(JSON.stringify({ run_id: "run_live", status: "running" }), { status: 200 });
      await requestHermesReview(app, PR);
      await expect(requestHermesReview(app, PR)).rejects.toThrow(/run_live/);
    });

    it("does not treat a finished review as in flight", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      dispatch = async () => accepted("run_done");
      runEndpoint = async () =>
        new Response(JSON.stringify({ run_id: "run_done", status: "completed" }), { status: 200 });
      await requestHermesReview(app, PR);
      await requestHermesReview(app, PR);
      expect(calls("/v1/runs")).toHaveLength(2);
    });

    it("treats a status it has never seen as live, not as finished", async () => {
      // Hermes parks a run in `waiting_for_approval` while the agent waits for
      // a tool approval — a status missing from a "live" list reads as
      // finished, and a second review is dispatched.
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      dispatch = async () => accepted("run_parked");
      runEndpoint = async () =>
        new Response(JSON.stringify({ run_id: "run_parked", status: "waiting_for_approval" }), {
          status: 200,
        });
      await requestHermesReview(app, PR);
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(ReviewInFlightError);
    });

    it("refuses a commit that has already been reviewed — there is nothing new to review", async () => {
      // The range would be empty (the last landed review is on this very
      // commit), and an empty range is a key the previous round never used:
      // dispatching it is how the same diff got reviewed twice.
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      await expect(
        requestHermesReview(app, { ...PR, resolveBase: async () => PR.headSha }),
      ).rejects.toBeInstanceOf(ReviewAlreadyLandedError);
      // Nothing was dispatched: the refusal IS the answer.
      expect(calls("/v1/runs")).toHaveLength(0);
    });

    it("words the in-flight refusal for an issue triage", async () => {
      applySettingsPatch(app, {
        reviewRelay: { triagePromptRepo: "acme/.github", triagePromptPath: "triage.md" },
      });
      await requestRelay(app, ISSUE);
      runEndpoint = async () =>
        new Response(JSON.stringify({ run_id: "run_1", status: "running" }), { status: 200 });
      await expect(requestRelay(app, ISSUE)).rejects.toThrow(/triage of this issue/);
    });

    it("starts a fresh attempt when the range's previous run failed (#1750)", async () => {
      // Hermes replays the run a key names, so a failed run would make every
      // retry replay it — "ask again" would do nothing. A retry therefore goes
      // under a deeper key, derived from the run that failed.
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      let calls = 0;
      // The first attempt finds the range's run, and it FAILED; the second
      // attempt (under the deeper key) is fresh.
      dispatch = async () => {
        calls += 1;
        if (calls === 1) {
          return new Response(
            JSON.stringify({ run_id: "run_failed", status: "failed", replayed: true }),
            { status: 202, headers: { "Idempotency-Replayed": "true" } },
          );
        }
        return accepted("run_second");
      };
      const run = await requestHermesReview(app, PR);
      // The second attempt went under a deeper key — and it was dispatched.
      const keys = fetchMock.mock.calls
        .filter(([u]) => String(u).endsWith("/v1/runs"))
        .map(
          ([, init]) =>
            (init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"],
        );
      expect(keys[0]).toBe("hermes-review:acme/widgets#7@..abc1234");
      expect(keys[1]).toBe("hermes-review:acme/widgets#7@..abc1234#run_failed");
      expect(run.replayed).toBe(false);
      expect(run.runId).toBe("run_second");
    });

    it("refuses a range whose run is still working, without a second dispatch", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      dispatch = async () =>
        new Response(JSON.stringify({ run_id: "run_live", status: "running", replayed: true }), {
          status: 202,
          headers: { "Idempotency-Replayed": "true" },
        });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(ReviewInFlightError);
      expect(calls("/v1/runs")).toHaveLength(1);
    });

    it("does not treat an unreadable run status as in flight", async () => {
      applySettingsPatch(app, { reviewRelay: { cooldownMinutes: 0 } });
      dispatch = async () => accepted("run_x");
      runEndpoint = async () => new Response("nope", { status: 500 });
      await requestHermesReview(app, PR);
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_x" });
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
      // The key names the review RANGE, not the request: a repeat request for
      // the same range must not dispatch a second review of the same diff.
      expect(headers["Idempotency-Key"]).toBe("hermes-review:acme/widgets#7@..abc1234");
      expect(init.redirect).toBe("manual");
      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("hermes-agent");
      expect(body.input).toContain("Target: pr #7 in repo acme/widgets");
      expect(body.input).toContain("REVIEW PROMPT BODY");
    });

    it("a retry of the same range reuses the key, and so does a later request for it", async () => {
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
        // The key does NOT roll with the cooldown any more: it names the range,
        // so a later request for the same range replays the existing run
        // instead of dispatching a second review of the same diff.
        expect(keyOf(2)["Idempotency-Key"]).toBe(keyOf(1)["Idempotency-Key"]);
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

    it("retries a stuck review session in a fresh one", async () => {
      // Hermes' session authority refused the turn: the session this pull
      // request's reviews run in is stuck — the gateway paused it on an
      // earlier conflict and never recovers
      // (NousResearch/hermes-agent#142731) — so it refuses every later round.
      // The relay starts over in a fresh session, and under a key that moves
      // with it, because the body carries the session id.
      let n = 0;
      dispatch = async () => {
        n += 1;
        if (n === 1) {
          return new Response('{"error":{"code":"admission_conflict"}}', { status: 409 });
        }
        return accepted("run_fresh");
      };
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_fresh" });
      const posts = calls("/v1/runs");
      const bodyOf = (i: number) => JSON.parse((posts[i][1] as RequestInit).body as string);
      const keyOf = (i: number) =>
        (posts[i][1] as RequestInit & { headers: Record<string, string> }).headers[
          "Idempotency-Key"
        ];
      expect(bodyOf(0).session_id).toBe("hermes-review-acme-widgets-7");
      expect(bodyOf(1).session_id).toBe("hermes-review-acme-widgets-7-2");
      expect(keyOf(0)).toBe("hermes-review:acme/widgets#7@..abc1234");
      expect(keyOf(1)).toBe("hermes-review:acme/widgets#7@..abc1234#session-2");
    });

    it("gives up when every session is refused by the stuck session", async () => {
      // The session budget is its own: a stuck session is not a failed
      // attempt at the range, so it must not eat the range's attempts.
      dispatch = async () =>
        new Response('{"error":{"code":"admission_conflict"}}', { status: 409 });
      await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
      expect(calls("/v1/runs")).toHaveLength(3);
    });

    it("still dispatches after two stuck sessions", async () => {
      // The range's attempts and the session's attempts are separate budgets:
      // two refused sessions must leave an attempt for the dispatch itself.
      let n = 0;
      dispatch = async () => {
        n += 1;
        if (n <= 2) {
          return new Response('{"error":{"code":"admission_conflict"}}', { status: 409 });
        }
        return accepted("run_third");
      };
      await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_third" });
      const bodies = calls("/v1/runs").map(([, init]) =>
        JSON.parse((init as RequestInit).body as string),
      );
      expect(bodies.map((b) => b.session_id)).toEqual([
        "hermes-review-acme-widgets-7",
        "hermes-review-acme-widgets-7-2",
        "hermes-review-acme-widgets-7-3",
      ]);
    });

    it("continues in the session the previous round moved to", async () => {
      // A round whose own session was stuck moves to a fresh one and records
      // it on its in-flight marker. The next round continues THERE, instead
      // of starting from the stuck base id (which would be refused at the
      // door, every round). The shared workflow reads the same marker.
      checkRuns = async () =>
        new Response(
          JSON.stringify({
            check_runs: [
              {
                id: 1,
                name: "Hermes review",
                external_id: "run_prev",
                status: "completed",
                output: { summary: "session: hermes-review-acme-widgets-7-2" },
              },
            ],
          }),
          { status: 200 },
        );
      await requestHermesReview(app, {
        ...PR,
        githubToken: "gh-token",
        resolveBase: async () => "base123",
      });
      const [post] = calls("/v1/runs");
      const body = JSON.parse((post[1] as RequestInit).body as string);
      expect(body.session_id).toBe("hermes-review-acme-widgets-7-2");
    });

    it("takes the NEWEST marker on the base commit, not the oldest", async () => {
      // The check-runs endpoint answers newest first, so the newest marker is
      // the FIRST one — taking the last would send the next round back into
      // the stuck session the fresh one was left to avoid. Two markers on one
      // commit: the stuck base id, then the one the round actually used.
      checkRuns = async () =>
        new Response(
          JSON.stringify({
            check_runs: [
              {
                id: 900,
                name: "Hermes review",
                external_id: "run_new",
                status: "completed",
                output: { summary: "session: hermes-review-acme-widgets-7-2" },
              },
              {
                id: 800,
                name: "Hermes review",
                external_id: "run_old",
                status: "completed",
                output: { summary: "session: hermes-review-acme-widgets-7" },
              },
            ],
          }),
          { status: 200 },
        );
      await requestHermesReview(app, {
        ...PR,
        githubToken: "gh-token",
        resolveBase: async () => "base123",
      });
      const [post] = calls("/v1/runs");
      const body = JSON.parse((post[1] as RequestInit).body as string);
      expect(body.session_id).toBe("hermes-review-acme-widgets-7-2");
    });

    it("ignores a remembered session that is not this pull request's", async () => {
      // Only an id of the exact shape this code generates is honoured: a
      // malformed id, or one belonging to another pull request, must not be
      // used — it would put this pull request's rounds in another one's
      // conversation.
      for (const summary of [
        "session: hermes-review-acme-widgets-9-2",
        "session: not-a-session-id",
        "session: hermes-review-acme-widgets-7-2-3",
        "no session here",
      ]) {
        resetHermesReviewState();
        checkRuns = async () =>
          new Response(
            JSON.stringify({
              check_runs: [{ id: 1, name: "Hermes review", output: { summary } }],
            }),
            { status: 200 },
          );
        await requestHermesReview(app, {
          ...PR,
          githubToken: "gh-token",
          resolveBase: async () => "base123",
        });
        const [post] = calls("/v1/runs");
        const body = JSON.parse((post[1] as RequestInit).body as string);
        expect(body.session_id).toBe("hermes-review-acme-widgets-7");
      }
    });

    it("writes the in-flight marker, with the session the round runs in", async () => {
      // The marker is what the shared workflow reads to see that a review of
      // this pull request is already running — and which session it runs in.
      let written: Record<string, unknown> = {};
      createCheckRun = async (init: RequestInit) => {
        written = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(JSON.stringify({ id: 4242 }), { status: 201 });
      };
      await requestHermesReview(app, { ...PR, githubToken: "gh-token" });
      expect(written.name).toBe("Hermes review");
      expect(written.head_sha).toBe("abc1234");
      expect(written.external_id).toBe("run_1");
      expect(written.status).toBe("in_progress");
      expect((written.output as { summary: string }).summary).toBe(
        "session: hermes-review-acme-widgets-7",
      );
    });

    it("retries a replayed run that completed without landing a review", async () => {
      // A replay means the range already has a run. What the request means
      // then depends on that run: still working -> refused as in flight (with
      // its run id); failed -> retried under a deeper key; completed -> ALSO
      // retried, because a completed run is not evidence that a review landed
      // (Hermes reports "completed" for a run that posted nothing). The
      // empty-range check is what refuses an already-reviewed commit.
      let n = 0;
      dispatch = async () => {
        n += 1;
        if (n === 1) {
          return new Response('{"run_id":"run_old","status":"completed"}', {
            status: 202,
            headers: { "Idempotency-Replayed": "true" },
          });
        }
        return accepted("run_second");
      };
      const run = await requestHermesReview(app, PR);
      expect(run.runId).toBe("run_second");
      const keys = fetchMock.mock.calls
        .filter(([u]) => String(u).endsWith("/v1/runs"))
        .map(
          ([, init]) =>
            (init as RequestInit & { headers: Record<string, string> }).headers["Idempotency-Key"],
        );
      expect(keys[0]).toBe("hermes-review:acme/widgets#7@..abc1234");
      expect(keys[1]).toBe("hermes-review:acme/widgets#7@..abc1234#run_old");
    });

    it("refuses a range whose review already landed", async () => {
      // The commit the previous round covered IS the head: the range is
      // empty, so there is nothing to review. This is the only "already
      // landed" refusal — a replayed run does not make one.
      await expect(
        requestHermesReview(app, { ...PR, resolveBase: async () => PR.headSha }),
      ).rejects.toBeInstanceOf(ReviewAlreadyLandedError);
    });

    it("keys a request by its range, not by the clock, even with the cooldown off", async () => {
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
      // The key used to carry a time bucket, so a request after the cooldown
      // window dispatched a SECOND review of the same diff — the pile-up. It
      // names the range now, so the second request replays the first run.
      expect(keys[0]).toBe(keys[1]);
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

      it("refuses a target without a head commit rather than collapsing every commit into one key", async () => {
        // An empty sha would make the cooldown key PR-wide again — silently
        // restoring the behavior this change removes.
        await expect(requestHermesReview(app, { ...PR, headSha: "" })).rejects.toBeInstanceOf(
          HermesNotConfiguredError,
        );
        expect(calls("/v1/runs")).toHaveLength(0);
      });

      it("sweeps expired cooldown entries so the map cannot grow without bound", async () => {
        // The cooldown is keyed by commit now, so its key space is every
        // commit ever reviewed. A swept entry and an expired-but-still-present
        // one behave the same, so the only observable difference is the map's
        // size — the test has to look at it.
        vi.useFakeTimers({ toFake: ["Date"] });
        try {
          const base = Date.now();
          for (let i = 0; i < 1_100; i += 1) {
            vi.setSystemTime(base + i);
            await requestHermesReview(app, { ...PR, headSha: `sha${i}` });
          }
          expect(cooldownEntryCount()).toBeGreaterThan(1_000);

          // Well past the cooldown window: the next request sweeps.
          vi.setSystemTime(base + 11 * 60_000);
          await requestHermesReview(app, { ...PR, headSha: "fresh" });
          // Every entry older than the window is gone; only the fresh one
          // remains.
          expect(cooldownEntryCount()).toBeLessThanOrEqual(2);
        } finally {
          vi.useRealTimers();
        }
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

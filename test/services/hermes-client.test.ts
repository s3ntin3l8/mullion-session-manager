import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";
import {
  HermesAuthError,
  HermesNotConfiguredError,
  HermesUnavailableError,
  ReviewConflictError,
  ReviewSessionRefusedError,
  checkHealth,
  getRun,
  isGone,
  isTerminal,
  postRun,
  resolveHermesConfig,
  stopRun,
} from "../../src/services/hermes-client.js";
import {
  buildTaskReviewMessage,
  dispatchTaskReview,
  extractFindingsJson,
  isUnsentRunId,
  pollTaskReview,
  stopHermesRunQuietly,
  taskReviewIdempotencyKey,
  taskReviewSessionId,
  unsentRunId,
} from "../../src/services/hermes-task-review.js";
import { reviewIdempotencyKey, reviewSessionId } from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `hermes-client-test-${process.pid}.db`);
const API = "http://192.168.2.6:8643";
const CFG = { root: API, key: "k" }; // pragma: allowlist secret
const json = (body: unknown, init: ResponseInit = { status: 200 }) =>
  new Response(JSON.stringify(body), init);

describe("hermes client", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let route: (url: string, init: RequestInit) => Promise<Response>;
  let fetchMock: ReturnType<typeof vi.fn>;

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
    applySettingsPatch(app, {
      reviewRelay: { provider: "none", apiUrl: API, model: "", modelProvider: "" },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    route = async () => new Response("", { status: 404 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => route(url, init ?? {}));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
  });

  describe("resolveHermesConfig", () => {
    it("accepts provider none when the provider is not required", () => {
      expect(resolveHermesConfig(app, { requireProvider: false })).toEqual({
        root: API,
        key: "sekret-key", // pragma: allowlist secret
      });
    });

    it("still demands the hermes provider by default", () => {
      expect(() => resolveHermesConfig(app)).toThrow(HermesNotConfiguredError);
    });

    it("needs a URL and a key either way", () => {
      clearHermesKey(app);
      expect(() => resolveHermesConfig(app, { requireProvider: false })).toThrow(/not configured/);
    });

    it("strips a trailing slash and rejects a bad URL", () => {
      applySettingsPatch(app, { reviewRelay: { apiUrl: `${API}///` } });
      expect(resolveHermesConfig(app, { requireProvider: false }).root).toBe(API);
      applySettingsPatch(app, { reviewRelay: { apiUrl: "ftp://nope" } });
      expect(() => resolveHermesConfig(app, { requireProvider: false })).toThrow(/valid http/);
    });
  });

  describe("postRun", () => {
    const req = { input: "hi", idempotencyKey: "key-1" };

    it("returns the run on 202 and sends key, session and model", async () => {
      route = async () => json({ run_id: "run_1", status: "queued" }, { status: 202 });
      const run = await postRun(CFG, { ...req, sessionId: "s1", model: "m", provider: "p" });
      expect(run).toEqual({ runId: "run_1", status: "queued", replayed: false });
      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers["Idempotency-Key"]).toBe("key-1");
      expect(init.headers.Authorization).toBe("Bearer k");
      expect(JSON.parse(init.body)).toEqual({
        input: "hi",
        model: "m",
        provider: "p",
        session_id: "s1",
      });
    });

    it("omits the provider without a model, and reads replays from header or body", async () => {
      route = async () =>
        json(
          { run_id: "run_2", status: "completed" },
          { status: 200, headers: { "idempotency-replayed": "true" } },
        );
      const run = await postRun(CFG, { ...req, provider: "p" });
      expect(run.replayed).toBe(true);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ input: "hi" });
      route = async () => json({ run_id: "run_3", replayed: true });
      expect((await postRun(CFG, req)).replayed).toBe(true);
    });

    it("maps 409 idempotency_key_conflict", async () => {
      route = async () => json({ error: { code: "idempotency_key_conflict" } }, { status: 409 });
      await expect(postRun(CFG, req)).rejects.toBeInstanceOf(ReviewConflictError);
    });

    it("maps 409 admission_conflict to a refused session, only with a session", async () => {
      route = async () => json({ code: "admission_conflict" }, { status: 409 });
      await expect(postRun(CFG, { ...req, sessionId: "s1" })).rejects.toBeInstanceOf(
        ReviewSessionRefusedError,
      );
      await expect(postRun(CFG, req)).rejects.toBeInstanceOf(HermesUnavailableError);
    });

    it("fails on a run-less 202 and on other statuses", async () => {
      route = async () => json({ status: "queued" }, { status: 202 });
      await expect(postRun(CFG, req)).rejects.toThrow(/no run id/);
      route = async () => new Response("boom", { status: 500 });
      await expect(postRun(CFG, req)).rejects.toBeInstanceOf(HermesUnavailableError);
    });

    it("surfaces 401/403 as an auth error", async () => {
      for (const status of [401, 403]) {
        route = async () => new Response("", { status });
        await expect(postRun(CFG, req)).rejects.toBeInstanceOf(HermesAuthError);
      }
    });

    it("carries retry-after from a 429", async () => {
      route = async () =>
        new Response("slow down", { status: 429, headers: { "retry-after": "12" } });
      await expect(postRun(CFG, req)).rejects.toMatchObject({ retryAfterSeconds: 12 });
    });

    it("wraps a network failure", async () => {
      route = async () => Promise.reject(new Error("ECONNREFUSED"));
      await expect(postRun(CFG, req)).rejects.toBeInstanceOf(HermesUnavailableError);
    });
  });

  describe("getRun", () => {
    it.each(["completed", "failed", "cancelled", "interrupted"])(
      "reads %s as terminal",
      async (status) => {
        route = async () => json({ status, output: "o", error: "e" });
        const run = await getRun(CFG, "run_1");
        expect(run).toEqual({ status, output: "o", error: "e", shuttingDown: false });
        expect(isTerminal(run.status)).toBe(true);
        expect(isGone(run.status)).toBe(false);
      },
    );

    it("leaves a status it does not know live", async () => {
      route = async () => json({ status: "waiting_for_approval", shutdown_requested_at: 5 });
      const run = await getRun(CFG, "run_1");
      expect(isTerminal(run.status) || isGone(run.status)).toBe(false);
      expect(run.shuttingDown).toBe(true);
    });

    it.each(["not_found", "expired", "unknown"])("treats %s as gone", async (status) => {
      route = async () => json({ status });
      expect(isGone((await getRun(CFG, "run_1")).status)).toBe(true);
    });

    it("answers not_found for a 404 and unknown for an unreadable 200", async () => {
      expect((await getRun(CFG, "run_1")).status).toBe("not_found");
      route = async () => new Response("<html>proxy</html>", { status: 200 });
      expect((await getRun(CFG, "run_1")).status).toBe("unknown");
      route = async () => json({ output: "x" });
      expect((await getRun(CFG, "run_1")).status).toBe("unknown");
    });

    it("returns an output over 4,000 characters intact", async () => {
      const output = "x".repeat(50_000);
      route = async () => json({ status: "completed", output, error: output });
      const run = await getRun(CFG, "run_1");
      expect(run.output).toBe(output);
      expect(run.error).toBe(output);
    });

    it("reads a body just under the 256 KB cap, and gives up over it", async () => {
      route = async () => json({ status: "completed", output: "y".repeat(250_000) });
      expect((await getRun(CFG, "run_1")).output).toHaveLength(250_000);
      route = async () => json({ status: "completed", output: "y".repeat(300_000) });
      expect((await getRun(CFG, "run_1")).status).toBe("unknown");
    });

    it("surfaces 5xx and auth errors, and encodes the run id", async () => {
      route = async () => new Response("", { status: 503 });
      await expect(getRun(CFG, "run_1")).rejects.toBeInstanceOf(HermesUnavailableError);
      route = async () => new Response("", { status: 401 });
      await expect(getRun(CFG, "run_1")).rejects.toBeInstanceOf(HermesAuthError);
      route = async () => json({ status: "completed" });
      await getRun(CFG, "a/b");
      expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(`${API}/v1/runs/a%2Fb`);
    });
  });

  describe("stopRun", () => {
    it("posts to the stop endpoint", async () => {
      route = async () => json({ status: "stopping" });
      expect(await stopRun(CFG, "run_1")).toEqual({ status: "stopping", found: true });
      expect(fetchMock.mock.calls[0][0]).toBe(`${API}/v1/runs/run_1/stop`);
      expect(fetchMock.mock.calls[0][1].method).toBe("POST");
    });

    it("defaults the status, reports a 404 and fails on 5xx", async () => {
      route = async () => new Response("not json", { status: 200 });
      expect((await stopRun(CFG, "run_1")).status).toBe("stopping");
      route = async () => new Response("", { status: 404 });
      expect(await stopRun(CFG, "run_1")).toEqual({ status: "not_found", found: false });
      route = async () => new Response("", { status: 500 });
      await expect(stopRun(CFG, "run_1")).rejects.toBeInstanceOf(HermesUnavailableError);
    });
  });

  describe("checkHealth", () => {
    it("passes on 200", async () => {
      route = async () => new Response("ok");
      await expect(checkHealth(API)).resolves.toBeUndefined();
    });

    it("hides the detail unless verbose", async () => {
      route = async () => new Response("", { status: 500 });
      await expect(checkHealth(API)).rejects.toThrow(
        "The Hermes API is unreachable — review not dispatched",
      );
      await expect(checkHealth(API, true)).rejects.toThrow(/HTTP 500/);
    });
  });

  describe("task review", () => {
    const target = { owner: "Acme", repo: "Widgets", prNumber: 7, headSha: "h1", baseSha: "b0" };

    it("keys and sessions are distinct from the relay's", () => {
      const key = taskReviewIdempotencyKey(target, { taskId: 5, round: 2, rearms: 1 });
      expect(key).toBe("mullion-task-review:acme/widgets#7:t5:r2:x1@b0..h1");
      expect(key).not.toBe(reviewIdempotencyKey("acme", "widgets", 7, "b0", "h1"));
      expect(taskReviewSessionId({ taskId: 5, round: 2 })).toBe("mullion-task-5-r2");
      expect(taskReviewSessionId({ taskId: 5, round: 2 })).not.toBe(
        reviewSessionId("acme", "widgets", 7),
      );
      expect(
        taskReviewIdempotencyKey(
          { ...target, baseSha: undefined },
          { taskId: 5, round: 1, rearms: 0 },
        ),
      ).toBe("mullion-task-review:acme/widgets#7:t5:r1:x0@..h1");
    });

    it("builds a read-only message without the post-as-App paragraph", () => {
      const msg = buildTaskReviewMessage(target, "THE PROMPT");
      expect(msg).toContain("Target: pr #7 in repo Acme/Widgets");
      expect(msg).toContain("at commit h1 — that exact commit");
      expect(msg).toContain("range b0..h1");
      expect(msg).toContain("ONLY the findings JSON");
      expect(msg).toContain("post nothing to GitHub");
      expect(msg).not.toContain("GitHub App");
      expect(msg.endsWith("THE PROMPT")).toBe(true);
      expect(buildTaskReviewMessage({ ...target, baseSha: undefined }, "p")).not.toContain(
        "FOLLOW-UP",
      );
    });

    it("dispatches without the relay provider, then polls by run id", async () => {
      route = async (url) => {
        if (url === `${API}/health`) return new Response("ok");
        if (url === `${API}/v1/runs`)
          return json({ run_id: "run_9", status: "queued" }, { status: 202 });
        return json({ status: "completed", output: "z".repeat(9_000) });
      };
      const out = await dispatchTaskReview(app, {
        taskId: 5,
        round: 1,
        rearms: 0,
        target,
        prompt: "P",
        model: "m",
      });
      expect(out).toMatchObject({
        runId: "run_9",
        sessionId: "mullion-task-5-r1",
        idempotencyKey: "mullion-task-review:acme/widgets#7:t5:r1:x0@b0..h1",
      });
      const post = fetchMock.mock.calls.find(([u]) => u === `${API}/v1/runs`)!;
      expect(JSON.parse(post[1].body)).toMatchObject({
        model: "m",
        session_id: "mullion-task-5-r1",
      });
      const polled = await pollTaskReview(app, "run_9");
      expect(polled).toMatchObject({ status: "completed", terminal: true, gone: false });
      expect(polled.output).toHaveLength(9_000);
    });

    it("reports a gone run", async () => {
      expect(await pollTaskReview(app, "run_x")).toMatchObject({
        status: "not_found",
        terminal: false,
        gone: true,
      });
    });

    it("does not dispatch when the health check fails", async () => {
      route = async () => new Response("", { status: 500 });
      await expect(
        dispatchTaskReview(app, { taskId: 5, round: 1, rearms: 0, target, prompt: "P" }),
      ).rejects.toBeInstanceOf(HermesUnavailableError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe("extractFindingsJson", () => {
  const obj = '{"verdict":"approved","summary":"ok","findings":[]}';

  it("takes a raw object, trimmed", () => {
    expect(extractFindingsJson(`  \n${obj}\n `)).toBe(obj);
  });

  it("takes a fenced block, with or without the json tag", () => {
    expect(extractFindingsJson("```json\n" + obj + "\n```")).toBe(obj);
    expect(extractFindingsJson("```\n" + obj + "\n```")).toBe(obj);
  });

  it("takes a fenced block from prose", () => {
    expect(extractFindingsJson(`Here you go:\n\`\`\`json\n${obj}\n\`\`\`\nHope that helps.`)).toBe(
      obj,
    );
  });

  it("skips a fenced block that is not an object", () => {
    expect(extractFindingsJson("```\nnpm test\n```\nthen\n```json\n" + obj + "\n```")).toBe(obj);
  });

  it("takes bare JSON from prose", () => {
    expect(extractFindingsJson(`My verdict: ${obj} — done.`)).toBe(obj);
  });

  it("balances nested braces and ignores braces in strings", () => {
    const tricky =
      '{"verdict":"changes-requested","summary":"a } and { b","findings":[{"path":"a.ts","body":"use \\"{x}\\" here"}]}';
    expect(extractFindingsJson(`note {not json} then ${tricky} trailing {`)).toBe(tricky);
  });

  it("returns null for garbage, arrays, unbalanced and empty input", () => {
    expect(extractFindingsJson("no findings here")).toBeNull();
    expect(extractFindingsJson("[1,2,3]")).toBeNull();
    expect(extractFindingsJson('{"verdict": "approved"')).toBeNull();
    expect(extractFindingsJson('{"a": "unterminated}')).toBeNull();
    expect(extractFindingsJson("")).toBeNull();
    expect(extractFindingsJson("   \n ")).toBeNull();
  });
});

describe("a review run that never was, and stopping one without waiting (#2369)", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const dbFile = path.join(os.tmpdir(), `hermes-stop-test-${process.pid}.db`);
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  beforeAll(async () => {
    fs.rmSync(dbFile, { force: true });
    process.env.DATABASE_URL = `file:${dbFile}`;
    app = await buildApp();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    fs.rmSync(dbFile, { force: true });
    delete process.env.DATABASE_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
  });

  it("names the stand-in run by task, round and re-arm count, and recognises it", () => {
    const id = unsentRunId({ taskId: 7, round: 2, rearms: 1 });
    expect(id).toBe("unsent:7:r2:x1");
    expect(isUnsentRunId(id)).toBe(true);
    expect(isUnsentRunId("run_abc")).toBe(false);
  });

  it("ignores a missing or stand-in run id without touching the network", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    stopHermesRunQuietly(app, null);
    stopHermesRunQuietly(app, undefined);
    stopHermesRunQuietly(app, "unsent:7:r0:x0");
    await flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops a real run with the stored URL and key, whatever the relay provider is", async () => {
    applySettingsPatch(app, {
      reviewRelay: { provider: "none", apiUrl: API, model: "", modelProvider: "" },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    const fetchMock = vi.fn(async () => json({ status: "stopping" }));
    vi.stubGlobal("fetch", fetchMock);

    stopHermesRunQuietly(app, "run_9");
    await flush();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${API}/v1/runs/run_9/stop`);
  });

  it("swallows and logs a failure, so the caller's lifecycle step is never blocked", async () => {
    applySettingsPatch(app, {
      reviewRelay: { provider: "none", apiUrl: API, model: "", modelProvider: "" },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("", { status: 500 })),
    );
    const warn = vi.spyOn(app.log, "warn");

    expect(() => stopHermesRunQuietly(app, "run_9")).not.toThrow();
    await flush();
    await flush();

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_9" }),
      "task reconcile: failed to stop the Hermes review run",
    );
  });

  it("swallows a Hermes that is not configured at all", async () => {
    const warn = vi.spyOn(app.log, "warn");
    expect(() => stopHermesRunQuietly(app, "run_9")).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
  });
});

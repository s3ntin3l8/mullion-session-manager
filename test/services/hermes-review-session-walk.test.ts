import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";
import { requestHermesReview, resetHermesReviewState } from "../../src/services/hermes-review.js";
import { HermesUnavailableError } from "../../src/services/hermes-client.js";

// How the relay walks the pull request's Hermes session ids when Hermes
// refuses one: a stuck session (`admission_conflict`) and a retired one
// (`not_found`, deleted by Hermes' idle-session prune) have separate budgets.

const tmpDb = path.join(os.tmpdir(), `hermes-review-walk-test-${process.pid}.db`);
const API = "http://192.168.2.6:8643";
const PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/review.md";
const PR = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc1234" };
const BASE = "hermes-review-acme-widgets-7";

const refused = (code: string) => new Response(`{"error":{"code":"${code}"}}`, { status: 409 });
const accepted = () =>
  new Response(JSON.stringify({ run_id: "run_ok", status: "queued" }), { status: 202 });

describe("hermes review session walk", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // The Hermes POST /v1/runs: given the session id of the request body.
  let dispatch: (sessionId: string) => Response;

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
        modelProvider: "",
        promptRepo: "acme/.github",
        promptPath: "review.md",
        cooldownMinutes: 10,
      },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    dispatch = () => accepted();
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return Promise.resolve(new Response("PROMPT", { status: 200 }));
      if (url === `${API}/health`) return Promise.resolve(new Response("ok", { status: 200 }));
      if (url === `${API}/v1/runs`) {
        const body = JSON.parse((init?.body as string) ?? "{}") as { session_id: string };
        return Promise.resolve(dispatch(body.session_id));
      }
      if (url.includes("/commits/") && url.includes("/check-runs")) {
        return Promise.resolve(new Response(JSON.stringify({ check_runs: [] }), { status: 200 }));
      }
      if (url === "https://api.github.com/repos/acme/widgets/check-runs") {
        return Promise.resolve(new Response(JSON.stringify({ id: 4242 }), { status: 201 }));
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
  });

  const tried = () =>
    fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith("/v1/runs"))
      .map(
        ([, init]) =>
          (JSON.parse((init as RequestInit).body as string) as { session_id: string }).session_id,
      );

  it("walks past more retired ids than the stuck budget, with no marker to remember", async () => {
    // The base, -2 and -3 were all pruned: the old budget of three ids
    // would have given up here, and the pull request never be reviewed again.
    const pruned = new Set([BASE, `${BASE}-2`, `${BASE}-3`, `${BASE}-4`]);
    dispatch = (id) => (pruned.has(id) ? refused("not_found") : accepted());
    await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_ok" });
    expect(tried()).toEqual([BASE, `${BASE}-2`, `${BASE}-3`, `${BASE}-4`, `${BASE}-5`]);
  });

  it("stops after a bounded number of retired ids", async () => {
    dispatch = () => refused("not_found");
    await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
    expect(tried()).toHaveLength(8);
  });

  it("keeps the stuck budget at three, retired ids or not", async () => {
    dispatch = () => refused("admission_conflict");
    await expect(requestHermesReview(app, PR)).rejects.toBeInstanceOf(HermesUnavailableError);
    expect(tried()).toHaveLength(3);
  });

  it("does not let retired ids eat the stuck budget", async () => {
    // Two retired ids, then two stuck ones: the stuck budget is still three.
    const refusals: Record<string, string> = {
      [BASE]: "not_found",
      [`${BASE}-2`]: "not_found",
      [`${BASE}-3`]: "admission_conflict",
      [`${BASE}-4`]: "admission_conflict",
    };
    dispatch = (id) => (refusals[id] ? refused(refusals[id]) : accepted());
    await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_ok" });
    expect(tried()).toHaveLength(5);
  });
});

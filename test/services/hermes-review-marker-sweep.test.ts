import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";
import {
  MARKER_MAX_AGE_MS,
  getReviewRunForPr,
  markerConclusionForRunStatus,
  requestHermesReview,
  resetHermesReviewState,
  sweepOpenReviewMarkers,
} from "../../src/services/hermes-review.js";

// The sweep mints its own App token per repository; the dispatch below is
// handed one directly, so only the sweep's mint goes through this mock.
const mintMarkerToken = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-integration.js", async () => ({
  ...(await vi.importActual<Record<string, unknown>>("../../src/services/github-integration.js")),
  resolveMarkerTokens: mintMarkerToken,
}));

const tmpDb = path.join(os.tmpdir(), `hermes-marker-sweep-test-${process.pid}.db`);
const API = "http://192.168.2.6:8643";
const PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/review.md";
const PR = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc1234" };
const MARKER_ID = 4242;

describe("review marker sweep", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // The Hermes run's status, as GET /v1/runs/<id> reports it.
  let runStatus: () => Response;
  // The PATCH /check-runs/<id> that closes the marker.
  let patched: Array<Record<string, unknown>>;
  let patchResponse: () => Response;

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

  beforeEach(async () => {
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
    mintMarkerToken.mockReset().mockResolvedValue({ markerToken: "sweep-token" });
    patched = [];
    runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: "running" }));
    patchResponse = () => new Response("{}", { status: 200 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return Promise.resolve(new Response("PROMPT"));
      if (url === `${API}/health`) return Promise.resolve(new Response("ok"));
      if (url === `${API}/v1/runs`) {
        return Promise.resolve(
          new Response(JSON.stringify({ run_id: "run_1", status: "queued" }), { status: 202 }),
        );
      }
      if (url === `${API}/v1/runs/run_1`) return Promise.resolve(runStatus());
      if (url.includes("/commits/") && url.includes("/check-runs")) {
        return Promise.resolve(new Response(JSON.stringify({ check_runs: [] })));
      }
      if (url === "https://api.github.com/repos/acme/widgets/check-runs") {
        return Promise.resolve(new Response(JSON.stringify({ id: MARKER_ID }), { status: 201 }));
      }
      if (url === `https://api.github.com/repos/acme/widgets/check-runs/${MARKER_ID}`) {
        patched.push({
          auth: (init?.headers as Record<string, string>)?.Authorization,
          ...JSON.parse(init?.body as string),
        });
        return Promise.resolve(patchResponse());
      }
      return Promise.reject(new Error(`unexpected fetch ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    await requestHermesReview(app, {
      ...PR,
      githubToken: "gh-token",
      markerWriteToken: "app-token",
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearHermesKey(app);
  });

  it("maps a run's status to the marker's conclusion", () => {
    expect(markerConclusionForRunStatus("completed")).toBe("success");
    for (const s of ["failed", "cancelled", "interrupted"]) {
      expect(markerConclusionForRunStatus(s)).toBe("failure");
    }
    for (const s of ["queued", "running", "unknown", "not_found"]) {
      expect(markerConclusionForRunStatus(s)).toBeNull();
    }
  });

  it("closes the marker as success once the run completed", async () => {
    runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: "completed" }));
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(1);
    expect(patched).toHaveLength(1);
    expect(patched[0]).toMatchObject({ status: "completed", conclusion: "success" });
    expect(patched[0].auth).toBe("Bearer sweep-token");
    expect(getReviewRunForPr("acme", "widgets", 7)?.markerCheckRunId).toBeUndefined();
  });

  it.each(["failed", "cancelled", "interrupted"])(
    "closes the marker as failure for %s",
    async (s) => {
      runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: s }));
      await sweepOpenReviewMarkers(app);
      expect(patched[0]).toMatchObject({ conclusion: "failure" });
    },
  );

  it("leaves the marker open while the run is still going", async () => {
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(patched).toHaveLength(0);
    expect(getReviewRunForPr("acme", "widgets", 7)?.markerCheckRunId).toBe(MARKER_ID);
  });

  it("closes a marker whose run is gone as neutral once it is too old", async () => {
    runStatus = () => new Response("{}", { status: 404 });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    const later = Date.now() + MARKER_MAX_AGE_MS + 1;
    await expect(sweepOpenReviewMarkers(app, later)).resolves.toBe(1);
    expect(patched[0]).toMatchObject({ conclusion: "neutral" });
  });

  it("closes an expired marker as neutral even when the run's status cannot be read", async () => {
    // A Hermes outage or a revoked key is the case the age limit is for.
    runStatus = () => new Response("{}", { status: 500 });
    const warn = vi.spyOn(app.log, "warn");
    const later = Date.now() + MARKER_MAX_AGE_MS + 1;
    await expect(sweepOpenReviewMarkers(app, later)).resolves.toBe(1);
    expect(patched[0]).toMatchObject({ conclusion: "neutral" });
    // Not silent: a neutral close for an unreadable run is distinguishable afterwards.
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run_1" }),
      expect.stringContaining("status is unreadable"),
    );
    warn.mockRestore();
  });

  it("keeps a young marker open, and retries, when the run's status cannot be read", async () => {
    runStatus = () => new Response("{}", { status: 500 });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(patched).toHaveLength(0);
    expect(getReviewRunForPr("acme", "widgets", 7)?.markerCheckRunId).toBe(MARKER_ID);
  });

  it("keeps the marker open when the token mint throws, and reads no run for it", async () => {
    mintMarkerToken.mockRejectedValue(new Error("mint failed"));
    fetchMock.mockClear();
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(patched).toHaveLength(0);
  });

  it("reads no run for a repository that has no App token", async () => {
    mintMarkerToken.mockResolvedValue({ markerToken: null, markerUnavailable: "not-installed" });
    fetchMock.mockClear();
    await sweepOpenReviewMarkers(app);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing, rather than throwing, when the Hermes URL is unusable", async () => {
    applySettingsPatch(app, { reviewRelay: { apiUrl: "not a url" } });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
  });

  it("closes a marker only once: a finished marker is not swept again", async () => {
    runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: "completed" }));
    await sweepOpenReviewMarkers(app);
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(patched).toHaveLength(1);
  });

  it("retries on the next pass when the close is refused", async () => {
    runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: "completed" }));
    patchResponse = () => new Response("{}", { status: 500 });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(getReviewRunForPr("acme", "widgets", 7)?.markerCheckRunId).toBe(MARKER_ID);
    patchResponse = () => new Response("{}", { status: 200 });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(1);
  });

  it("keeps the marker open when no App token can be minted", async () => {
    runStatus = () => new Response(JSON.stringify({ run_id: "run_1", status: "completed" }));
    mintMarkerToken.mockResolvedValue({ markerToken: null, markerUnavailable: "not-installed" });
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(patched).toHaveLength(0);
  });

  it("does nothing, and reads nothing, with no open marker", async () => {
    resetHermesReviewState();
    fetchMock.mockClear();
    await expect(sweepOpenReviewMarkers(app)).resolves.toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

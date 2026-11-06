import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { applySettingsPatch } from "../../src/services/settings.js";
import { clearHermesKey, setHermesKey } from "../../src/services/hermes-integration.js";
import {
  findHeadMarkerRun,
  getHermesReviewStatus,
  orphanMarkerConclusion,
  requestHermesReview,
  resetHermesReviewState,
  reviewStuckReason,
  REVIEW_STUCK_AFTER_MS,
} from "../../src/services/hermes-review.js";

// #2634 — the service half: a review this Mullion did not dispatch is found
// through the head's ledger marker. (hermes-review.test.ts covers the relay's
// own runs; it is kept from growing, so this lives in its own file.)
const tmpDb = path.join(os.tmpdir(), `hermes-review-ledger-test-${process.pid}.db`);

const API = "http://192.168.2.6:8643";
const PROMPT_URL = "https://raw.githubusercontent.com/acme/.github/HEAD/review.md";
const PR = { owner: "acme", repo: "widgets", prNumber: 7, headSha: "abc1234" };

describe("hermes review relay — ledger marker", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  let fetchMock: ReturnType<typeof vi.fn>;
  // GET /v1/runs/<id> — the status endpoint — and the check runs on a commit.
  let runEndpoint: (url: string, init: RequestInit) => Promise<Response>;
  let checkRuns: (init?: RequestInit) => Promise<Response>;

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
        ledgerName: "Hermes review",
      },
    });
    setHermesKey(app, "sekret-key"); // pragma: allowlist secret
    runEndpoint = async () => new Response("{}", { status: 404 });
    checkRuns = async () => new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
    fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === PROMPT_URL) return Promise.resolve(new Response("PROMPT", { status: 200 }));
      if (url === `${API}/health`) return Promise.resolve(new Response("ok", { status: 200 }));
      if (url === `${API}/v1/runs`) {
        return Promise.resolve(
          new Response(JSON.stringify({ run_id: "run_1", status: "queued" }), { status: 202 }),
        );
      }
      if (url.startsWith(`${API}/v1/runs/`)) return runEndpoint(url, init ?? {});
      if (url.includes("/commits/") && url.includes("/check-runs")) return checkRuns(init);
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

  // #2634 — a review this Mullion did not dispatch (the repository's own
  // workflow started it, or the run index was lost in a restart) is found
  // through the head's ledger marker: its external_id is the Hermes run id.
  describe("a review started outside this Mullion (#2634)", () => {
    const TOKEN = "gh-read-token"; // pragma: allowlist secret
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const markerRun = (over: Record<string, unknown> = {}) => ({
      id: 9,
      name: "Hermes review",
      external_id: "run_wf",
      status: "in_progress",
      conclusion: null,
      started_at: minutesAgo(5),
      completed_at: null,
      output: { summary: "session: hermes-review-acme-widgets-7" },
      ...over,
    });
    const withMarkers = (...runs: Array<Record<string, unknown>>) => {
      checkRuns = async () => new Response(JSON.stringify({ check_runs: runs }), { status: 200 });
    };
    const hermesRun = (status: string) => async () =>
      new Response(JSON.stringify({ object: "hermes.run", run_id: "run_wf", status }), {
        status: 200,
      });
    const head = { owner: "acme", repo: "widgets", headSha: "abc1234", readToken: TOKEN };
    const status = (over: Record<string, unknown> = {}) =>
      getHermesReviewStatus(app, { prNumber: 7, ...head, ...over });

    describe("findHeadMarkerRun", () => {
      it("returns the newest ledger marker with the Hermes run id it carries", async () => {
        withMarkers(
          markerRun({ id: 3, external_id: "run_old", status: "completed" }),
          markerRun({ id: 8, external_id: "run_new" }),
          { id: 99, name: "build", external_id: "x", status: "completed" },
        );
        await expect(findHeadMarkerRun(app, head)).resolves.toEqual({
          checkRunId: 8,
          runId: "run_new",
          open: true,
          startedAt: expect.any(String),
        });
      });

      it("reports a completed marker as closed", async () => {
        withMarkers(markerRun({ status: "completed", conclusion: "success" }));
        await expect(findHeadMarkerRun(app, head)).resolves.toMatchObject({ open: false });
      });

      it("is null with the ledger off, no marker, no run id, or an unreadable head", async () => {
        withMarkers(markerRun());
        applySettingsPatch(app, { reviewRelay: { ledgerName: "" } });
        await expect(findHeadMarkerRun(app, head)).resolves.toBeNull();
        applySettingsPatch(app, { reviewRelay: { ledgerName: "Hermes review" } });
        withMarkers();
        await expect(findHeadMarkerRun(app, head)).resolves.toBeNull();
        withMarkers(markerRun({ external_id: "" }));
        await expect(findHeadMarkerRun(app, head)).resolves.toBeNull();
        checkRuns = async () => new Response("boom", { status: 500 });
        await expect(findHeadMarkerRun(app, head)).resolves.toBeNull();
      });
    });

    describe("reviewStuckReason", () => {
      const now = Date.parse("2026-11-06T12:00:00Z");
      const old = now - REVIEW_STUCK_AFTER_MS - 1;
      const young = now - 5 * 60_000;

      it.each([
        ["running", true, young, null],
        ["running", true, old, "overdue"],
        ["queued", false, old, "overdue"],
        ["failed", true, young, "dead_run"],
        ["cancelled", true, young, "dead_run"],
        ["interrupted", true, young, "dead_run"],
        ["failed", false, old, null],
        ["completed", true, old, null],
        ["not_found", true, old, "lost_run"],
        ["not_found", true, young, null],
        ["not_found", false, old, null],
      ])("%s (marker open: %s) -> %s", (runStatus, open, startedAtMs, expected) => {
        expect(reviewStuckReason({ status: runStatus, open, startedAtMs, now })).toBe(expected);
      });

      it("never calls a run with an unreadable start time overdue", () => {
        expect(
          reviewStuckReason({ status: "running", open: true, startedAtMs: NaN, now }),
        ).toBeNull();
      });
    });

    describe("orphanMarkerConclusion", () => {
      const now = Date.parse("2026-11-06T12:00:00Z");
      it("closes a finished run's marker, and a lost run's only past the sweep's limit", () => {
        expect(orphanMarkerConclusion("completed", now, now)).toBe("success");
        expect(orphanMarkerConclusion("failed", now, now)).toBe("failure");
        expect(orphanMarkerConclusion("running", now - 9 * 3_600_000, now)).toBeNull();
        expect(orphanMarkerConclusion("not_found", now - 60 * 60_000, now)).toBeNull();
        expect(orphanMarkerConclusion("not_found", now - 3 * 3_600_000, now)).toBe("neutral");
      });
    });

    describe("getHermesReviewStatus", () => {
      it("asks Hermes about the run the marker names", async () => {
        withMarkers(markerRun());
        runEndpoint = async (url) => {
          expect(url).toBe(`${API}/v1/runs/run_wf`);
          return hermesRun("running")();
        };
        const result = await status();
        expect(result).toMatchObject({
          runId: "run_wf",
          status: "running",
          source: "ledger",
          headSha: "abc1234",
          repo: "acme/widgets",
          prNumber: 7,
          ledger: { checkRunId: 9, open: true },
        });
        expect(result).not.toHaveProperty("stuck");
      });

      it("flags a dead run behind an open marker", async () => {
        withMarkers(markerRun());
        runEndpoint = hermesRun("failed");
        await expect(status()).resolves.toMatchObject({
          status: "failed",
          stuck: true,
          stuckReason: "dead_run",
        });
      });

      it("flags a run still running past the window as overdue", async () => {
        withMarkers(markerRun({ started_at: minutesAgo(90) }));
        runEndpoint = hermesRun("running");
        await expect(status()).resolves.toMatchObject({ stuck: true, stuckReason: "overdue" });
      });

      it("flags a run Hermes lost, once the marker is past the window", async () => {
        withMarkers(markerRun({ started_at: minutesAgo(90) }));
        await expect(status()).resolves.toMatchObject({
          runId: "run_wf",
          status: "not_found",
          stuck: true,
          stuckReason: "lost_run",
        });
      });

      it("does not call a young lost run, or a closed marker's finished run, stuck", async () => {
        withMarkers(markerRun());
        await expect(status()).resolves.not.toHaveProperty("stuck");
        withMarkers(markerRun({ status: "completed", conclusion: "failure" }));
        runEndpoint = hermesRun("failed");
        await expect(status()).resolves.not.toHaveProperty("stuck");
      });

      it("stays not_found with no marker, with the ledger off, or without a read token", async () => {
        withMarkers();
        await expect(status()).resolves.toMatchObject({ status: "not_found" });
        withMarkers(markerRun());
        applySettingsPatch(app, { reviewRelay: { ledgerName: "" } });
        await expect(status()).resolves.toMatchObject({ status: "not_found" });
        applySettingsPatch(app, { reviewRelay: { ledgerName: "Hermes review" } });
        fetchMock.mockClear();
        await expect(status({ readToken: undefined })).resolves.toMatchObject({
          status: "not_found",
        });
        await expect(status({ headSha: undefined })).resolves.toMatchObject({
          status: "not_found",
        });
        expect(
          fetchMock.mock.calls.filter(([u]) => String(u).includes("/check-runs")),
        ).toHaveLength(0);
      });

      it("prefers the relay's own run over the marker", async () => {
        await requestHermesReview(app, PR);
        withMarkers(markerRun({ external_id: "run_other" }));
        runEndpoint = async () =>
          new Response(JSON.stringify({ run_id: "run_1", status: "running" }), { status: 200 });
        const result = await status();
        expect(result).toMatchObject({ runId: "run_1", status: "running" });
        expect(result).not.toHaveProperty("source");
      });

      describe("when the relay's run is for an older head", () => {
        const NEW_HEAD = { headSha: "def5678" };
        const byRun = (statuses: Record<string, string>) => async (url: string) => {
          const id = url.split("/").at(-1) as string;
          return new Response(JSON.stringify({ run_id: id, status: statuses[id] ?? "running" }), {
            status: 200,
          });
        };

        it("answers with the new head's marker, not the old run", async () => {
          await requestHermesReview(app, PR); // run_1, for abc1234
          withMarkers(markerRun());
          runEndpoint = byRun({ run_1: "completed", run_wf: "running" });
          const result = await status(NEW_HEAD);
          expect(result).toMatchObject({
            runId: "run_wf",
            status: "running",
            source: "ledger",
            headSha: "def5678",
          });
        });

        it("falls back to the relay's run when the new head has no marker", async () => {
          await requestHermesReview(app, PR);
          withMarkers();
          runEndpoint = byRun({ run_1: "completed" });
          const result = await status(NEW_HEAD);
          expect(result).toMatchObject({ runId: "run_1", status: "completed" });
          expect(result).not.toHaveProperty("source");
        });
      });

      it("flags a relay-tracked run that is still running past the window", async () => {
        await requestHermesReview(app, PR);
        runEndpoint = async () =>
          new Response(JSON.stringify({ run_id: "run_1", status: "running" }), { status: 200 });
        const realNow = Date.now();
        const spy = vi.spyOn(Date, "now").mockReturnValue(realNow + 2 * 3_600_000);
        try {
          await expect(getHermesReviewStatus(app, PR)).resolves.toMatchObject({
            runId: "run_1",
            stuck: true,
            stuckReason: "overdue",
          });
        } finally {
          spy.mockRestore();
        }
        await expect(getHermesReviewStatus(app, PR)).resolves.not.toHaveProperty("stuck");
      });
    });

    describe("the in-flight refusal", () => {
      const request = () => requestHermesReview(app, { ...PR, githubToken: TOKEN });

      it("refuses while the marker's run is still working, naming it", async () => {
        withMarkers(markerRun());
        runEndpoint = hermesRun("running");
        await expect(request()).rejects.toMatchObject({
          name: "ReviewInFlightError",
          runId: "run_wf",
        });
        expect(calls("/v1/runs").filter(([, init]) => init?.method === "POST")).toHaveLength(0);
      });

      it.each([
        ["a run that failed", markerRun(), "failed"],
        ["a run that completed", markerRun(), "completed"],
        ["a run Hermes lost", markerRun(), "not_found"],
        ["a closed marker", markerRun({ status: "completed", conclusion: "success" }), "running"],
      ])("lets the request through for %s", async (_name, marker, runStatus) => {
        withMarkers(marker);
        runEndpoint = hermesRun(runStatus);
        await expect(request()).resolves.toMatchObject({ runId: "run_1" });
      });

      it("still sees the head's live marker when the relay's run was for an older head", async () => {
        await requestHermesReview(app, PR); // run_1, for abc1234
        withMarkers(markerRun());
        runEndpoint = async (url) =>
          url.endsWith("run_1")
            ? new Response(JSON.stringify({ run_id: "run_1", status: "completed" }), {
                status: 200,
              })
            : hermesRun("running")();
        await expect(
          requestHermesReview(app, { ...PR, headSha: "def5678", githubToken: TOKEN }),
        ).rejects.toMatchObject({ name: "ReviewInFlightError", runId: "run_wf" });
      });

      it("does not let a run wedged past the stuck window block the head", async () => {
        // The relay cannot stop a run it did not dispatch, so refusing on it
        // would block the head until Hermes drops the run.
        withMarkers(markerRun({ started_at: minutesAgo(90) }));
        runEndpoint = hermesRun("running");
        await expect(request()).resolves.toMatchObject({ runId: "run_1" });
      });

      it("does not block indefinitely on a marker with no start time", async () => {
        // GitHub leaves started_at empty for a queued check run; it cannot be aged.
        withMarkers(markerRun({ started_at: null }));
        runEndpoint = hermesRun("running");
        await expect(request()).resolves.toMatchObject({ runId: "run_1" });
      });

      it("lets the request through when the marker cannot be read", async () => {
        checkRuns = async () => new Response("boom", { status: 500 });
        await expect(request()).resolves.toMatchObject({ runId: "run_1" });
      });

      it("lets the request through when Hermes cannot be asked about the run", async () => {
        withMarkers(markerRun());
        runEndpoint = async () => new Response("boom", { status: 500 });
        await expect(request()).resolves.toMatchObject({ runId: "run_1" });
      });

      it("does not look at the head's marker without a read token", async () => {
        withMarkers(markerRun());
        runEndpoint = hermesRun("running");
        await expect(requestHermesReview(app, PR)).resolves.toMatchObject({ runId: "run_1" });
      });
    });
  });
});

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as HermesReview from "../../src/services/hermes-review.js";

const mocks = vi.hoisted(() => ({
  assertReviewerConfigured: vi.fn(),
  listHermesReviews: vi.fn(),
  stopHermesReview: vi.fn(),
}));

vi.mock("../../src/services/hermes-review.js", async (orig) => ({
  ...(await orig<typeof HermesReview>()),
  assertReviewerConfigured: mocks.assertReviewerConfigured,
  listHermesReviews: mocks.listHermesReviews,
  stopHermesReview: mocks.stopHermesReview,
}));

import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import {
  HermesNotConfiguredError,
  ReviewRunNotFoundError,
} from "../../src/services/hermes-review.js";

const tmpDb = path.join(os.tmpdir(), `reviews-route-test-${process.pid}.db`);

describe("operator review routes", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

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
    vi.clearAllMocks();
    mocks.assertReviewerConfigured.mockReturnValue("key");
  });

  it("lists the tracked runs", async () => {
    mocks.listHermesReviews.mockResolvedValue([{ runId: "run_1", status: "running" }]);
    const res = await app.inject({ method: "GET", url: "/api/reviews" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runs: [{ runId: "run_1", status: "running" }] });
  });

  it("412s the list when no reviewer is configured", async () => {
    mocks.assertReviewerConfigured.mockImplementation(() => {
      throw new HermesNotConfiguredError("No reviewer is configured");
    });
    const res = await app.inject({ method: "GET", url: "/api/reviews" });
    expect(res.statusCode).toBe(412);
    expect(mocks.listHermesReviews).not.toHaveBeenCalled();
  });

  it("stops any tracked run without a session pin", async () => {
    mocks.stopHermesReview.mockResolvedValue({ runId: "run_1", status: "stopping" });
    const res = await app.inject({ method: "POST", url: "/api/reviews/run_1/stop" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ runId: "run_1", status: "stopping" });
    expect(mocks.stopHermesReview).toHaveBeenCalledWith(expect.anything(), "run_1");
  });

  it("404s an unknown run", async () => {
    mocks.stopHermesReview.mockRejectedValue(new ReviewRunNotFoundError());
    const res = await app.inject({ method: "POST", url: "/api/reviews/run_x/stop" });
    expect(res.statusCode).toBe(404);
  });
});

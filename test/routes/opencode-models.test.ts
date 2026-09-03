import { describe, it, expect, vi } from "vitest";

// Mock the whole service, not the `opencode` binary — the route calls
// listOpenCodeModels() with no arguments (src/routes/opencode-models.ts), so
// there's no exec-injection seam reachable from app.inject(). Mocking the
// binary would make this test depend on `opencode` being installed in CI.
// The service's own 1h in-memory cache is irrelevant here since the whole
// module is replaced — nothing to reset between runs.
vi.mock("../../src/services/opencode-models.js", () => ({
  listOpenCodeModels: vi
    .fn()
    .mockResolvedValue(["anthropic/claude-sonnet-4-5", "openrouter/minimax-m3"]),
}));

import { buildApp } from "../../src/app.js";

describe("GET /api/opencode/models", () => {
  // Regression: the route used to `return { models }`, an object, while
  // frontend/src/api/system.ts's listOpenCodeModels() is typed
  // `request<string[]>` — a bare array. The mismatch typechecked fine (the
  // client casts the JSON response `as Promise<T>`) but crashed
  // ModelsSection's `.map()` at runtime. This test pins the wire contract so
  // that regression can't silently return.
  it("returns a bare array, not an object wrapping the models", async () => {
    const app = await buildApp();
    const response = await app.inject({ method: "GET", url: "/api/opencode/models" });
    expect(response.statusCode).toBe(200);

    const body = response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual(["anthropic/claude-sonnet-4-5", "openrouter/minimax-m3"]);
    await app.close();
  });
});

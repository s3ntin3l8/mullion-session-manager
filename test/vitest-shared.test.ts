import { availableParallelism } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

// maxWorkers is computed at import time from the environment, so each case
// re-imports the module fresh.
async function load(ci: string | undefined) {
  vi.resetModules();
  if (ci === undefined) vi.stubEnv("CI", "");
  else vi.stubEnv("CI", ci);
  return (await import("../vitest.shared.js")).maxWorkers;
}

afterEach(() => vi.unstubAllEnvs());

describe("vitest.shared maxWorkers", () => {
  it("leaves Vitest's own default under CI", async () => {
    expect(await load("true")).toBeUndefined();
  });

  it("caps locally to a third of the cores, never below 2", async () => {
    expect(await load(undefined)).toBe(Math.max(2, Math.floor(availableParallelism() / 3)));
    expect(await load(undefined)).toBeGreaterThanOrEqual(2);
  });
});

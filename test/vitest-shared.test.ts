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

// reporters is also computed at import time; GITHUB_ACTIONS is stubbed too,
// since the suite itself may be running under GitHub Actions.
async function loadReporters(ci: string, githubActions: string) {
  vi.resetModules();
  vi.stubEnv("CI", ci);
  vi.stubEnv("GITHUB_ACTIONS", githubActions);
  return (await import("../vitest.shared.js")).reporters;
}

describe("vitest.shared reporters", () => {
  it("names the default reporter explicitly locally (an unset option picks a silent agent reporter)", async () => {
    expect(await loadReporters("", "")).toEqual(["default"]);
  });

  it("adds a junit.xml report under CI", async () => {
    expect(await loadReporters("true", "")).toEqual([
      "default",
      ["junit", { outputFile: "junit.xml" }],
    ]);
  });

  it("keeps the github-actions annotations under GitHub Actions", async () => {
    expect(await loadReporters("true", "true")).toEqual([
      "default",
      "github-actions",
      ["junit", { outputFile: "junit.xml" }],
    ]);
  });
});

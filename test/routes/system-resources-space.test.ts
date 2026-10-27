import { describe, expect, it, vi } from "vitest";
import type * as SpaceReport from "../../src/services/space-report.js";

const inspectSpaceReport = vi.fn(async (_options?: SpaceReport.SpaceReportOptions) => ({
  available: true,
  root: "/home/test",
  entries: [],
  scannedBytes: 1,
  filesystemUsedBytes: 2,
  outsideBytes: 1,
  unreadableEntries: 0,
}));
vi.mock("../../src/services/space-report.js", async (importOriginal) => ({
  ...(await importOriginal<typeof SpaceReport>()),
  inspectSpaceReport: (options?: SpaceReport.SpaceReportOptions) => inspectSpaceReport(options),
}));

import { projects } from "../../src/db/schema.js";
import { buildTestApp } from "../helpers/app.js";

describe("/api/storage/space", () => {
  it("measures once across polls, reports how long it took, and re-measures on refresh", async () => {
    inspectSpaceReport.mockClear();
    const app = await buildTestApp();
    const first = await app.inject({ method: "GET", url: "/api/storage/space" });
    expect(first.json()).toMatchObject({ available: true, scannedBytes: 1 });
    await app.inject({ method: "GET", url: "/api/storage/space" });
    expect(inspectSpaceReport).toHaveBeenCalledTimes(1);
    const again = await app.inject({ method: "GET", url: "/api/storage/space?refresh=1" });
    expect(inspectSpaceReport).toHaveBeenCalledTimes(2);
    expect(again.json()).toMatchObject({ state: "ready" });
    expect(typeof again.json().durationMs).toBe("number");
  });

  it("marks the cache, npm and opencode directories as ones cleanup owns", async () => {
    inspectSpaceReport.mockClear();
    const app = await buildTestApp();
    await app.inject({ method: "GET", url: "/api/storage/space" });
    const labels = (inspectSpaceReport.mock.calls[0]?.[0]?.covered ?? []).map((c) => c.label);
    expect(labels).toEqual(
      expect.arrayContaining(["uv", "Go module cache", "npm cache", "opencode database"]),
    );
    const covered = inspectSpaceReport.mock.calls[0]?.[0]?.covered ?? [];
    // Only the directory the temp tier empties, not all of ~/.npm.
    expect(covered.find((c) => c.label === "npm cache")?.path).toMatch(/\.npm\/_cacache$/);
  });

  it("marks every developer-worktree root of a local project, not just .wt", async () => {
    inspectSpaceReport.mockClear();
    const app = await buildTestApp();
    app.db.insert(projects).values({ name: "p", cwd: "/tmp/space-route-proj" }).run();
    await app.inject({ method: "GET", url: "/api/storage/space" });
    const covered = (inspectSpaceReport.mock.calls[0]?.[0]?.covered ?? [])
      .filter((c) => c.label === "developer worktrees")
      .map((c) => c.path);
    expect(covered).toEqual(
      expect.arrayContaining([
        "/tmp/space-route-proj/.wt",
        "/tmp/space-route-proj/.worktrees",
        "/tmp/space-route-proj/.claude/worktrees",
      ]),
    );
  });
});

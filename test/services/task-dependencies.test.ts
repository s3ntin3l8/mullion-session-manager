import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const mockListBlockedByIssues = vi.hoisted(() => vi.fn());
vi.mock("../../src/services/github-write.js", () => ({
  listBlockedByIssues: mockListBlockedByIssues,
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects } = await import("../../src/db/schema.js");
const { eq } = await import("drizzle-orm");
const { dependencyGate, parseBlockedBy, refreshTaskBlockers } =
  await import("../../src/services/task-dependencies.js");

describe("parseBlockedBy", () => {
  it("returns null for a null column", () => {
    expect(parseBlockedBy(null)).toBeNull();
  });

  it("returns null for malformed JSON — fail closed, not a throw", () => {
    expect(parseBlockedBy("{not json")).toBeNull();
  });

  it("returns null for valid JSON that isn't an array", () => {
    expect(parseBlockedBy('{"not":"an array"}')).toBeNull();
  });

  it("parses a real blocker array", () => {
    const blockers = [{ owner: "o", repo: "r", number: 5, title: "t", htmlUrl: "https://x/5" }];
    expect(parseBlockedBy(JSON.stringify(blockers))).toEqual(blockers);
  });

  it("parses an empty array (resolved, zero open blockers)", () => {
    expect(parseBlockedBy("[]")).toEqual([]);
  });
});

// Every row of the plan's gate table, asserted individually — see
// task-dependencies.ts's own dependencyGate doc comment for the table this
// mirrors.
describe("dependencyGate", () => {
  it("issueNumber null -> clear (local task, never gated, regardless of the other columns)", () => {
    expect(dependencyGate({ issueNumber: null, dependencyCount: null, blockedBy: null })).toBe(
      "clear",
    );
    expect(dependencyGate({ issueNumber: null, dependencyCount: 3, blockedBy: "[]" })).toBe(
      "clear",
    );
  });

  it("dependencyCount null -> unresolved (never observed)", () => {
    expect(dependencyGate({ issueNumber: 1, dependencyCount: null, blockedBy: null })).toBe(
      "unresolved",
    );
  });

  it("dependencyCount 0 -> clear, even with a stale/garbage blockedBy value", () => {
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 0, blockedBy: null })).toBe("clear");
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 0, blockedBy: "garbage" })).toBe(
      "clear",
    );
  });

  it("dependencyCount > 0, blockedBy null -> unresolved (check pending/failed)", () => {
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 2, blockedBy: null })).toBe(
      "unresolved",
    );
  });

  it("dependencyCount > 0, blockedBy '[]' -> clear (all blockers closed)", () => {
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 2, blockedBy: "[]" })).toBe("clear");
  });

  it("dependencyCount > 0, blockedBy non-empty -> blocked", () => {
    const blockers = JSON.stringify([
      { owner: "o", repo: "r", number: 9, title: "t", htmlUrl: "https://x/9" },
    ]);
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 2, blockedBy: blockers })).toBe(
      "blocked",
    );
  });

  it("malformed blockedBy with dependencyCount > 0 -> unresolved, not a throw", () => {
    expect(dependencyGate({ issueNumber: 1, dependencyCount: 2, blockedBy: "{not json" })).toBe(
      "unresolved",
    );
  });
});

describe("refreshTaskBlockers", () => {
  const tmpDb = path.join(os.tmpdir(), `task-dependencies-test-${process.pid}.db`);
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
    mockListBlockedByIssues.mockReset();
  });

  afterEach(() => {
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
  });

  async function createProjectAndTask(overrides: Partial<typeof tasks.$inferInsert> = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "task-dependencies-test-"));
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { createDir: true, name: "task-deps-p", cwd },
    });
    const projectId = res.json().id as number;
    const [row] = app.db
      .insert(tasks)
      .values({
        projectId,
        issueNumber: 10,
        title: "t",
        status: "ready",
        dependencyCount: 1,
        blockedBy: null,
        blockedByCheckedAt: null,
        ...overrides,
      })
      .returning()
      .all();
    return { projectId, task: row };
  }

  function getTask(taskId: number) {
    const [row] = app.db.select().from(tasks).where(eq(tasks.id, taskId)).all();
    return row;
  }

  it("stores only OPEN blockers, filtering out closed ones", async () => {
    const { task } = await createProjectAndTask({ dependencyCount: 2 });
    mockListBlockedByIssues.mockResolvedValue([
      {
        owner: "o",
        repo: "r",
        number: 1,
        title: "open one",
        htmlUrl: "https://x/1",
        state: "open",
      },
      {
        owner: "o",
        repo: "r",
        number: 2,
        title: "closed one",
        htmlUrl: "https://x/2",
        state: "closed",
      },
    ]);

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 2,
      token: "tok",
    });

    const row = getTask(task.id);
    const blockers = JSON.parse(row.blockedBy!);
    expect(blockers).toHaveLength(1);
    expect(blockers[0]).toMatchObject({ number: 1, title: "open one" });
    expect(row.blockedByCheckedAt).not.toBeNull();
  });

  it("stores an empty array when every blocker is closed", async () => {
    const { task } = await createProjectAndTask({ dependencyCount: 1 });
    mockListBlockedByIssues.mockResolvedValue([
      {
        owner: "o",
        repo: "r",
        number: 1,
        title: "closed",
        htmlUrl: "https://x/1",
        state: "closed",
      },
    ]);

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 1,
      token: "tok",
    });

    expect(JSON.parse(getTask(task.id).blockedBy!)).toEqual([]);
  });

  it("leaves blockedBy/blockedByCheckedAt untouched when the GitHub call throws — fail closed", async () => {
    const { task } = await createProjectAndTask({
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });
    mockListBlockedByIssues.mockRejectedValue(new Error("boom"));

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 1,
      token: "tok",
    });

    const row = getTask(task.id);
    expect(row.blockedBy).toBeNull();
    expect(row.blockedByCheckedAt).toBeNull();
  });

  it("treats fewer visible blockers than dependencyCount as blocked (defensive count check)", async () => {
    const { task } = await createProjectAndTask({ dependencyCount: 2 });
    // Only 1 of the 2 blockers GitHub's summary reported is visible to this
    // token (e.g. a private cross-org blocker) — the endpoint just returns
    // what it can see, with no error.
    mockListBlockedByIssues.mockResolvedValue([
      { owner: "o", repo: "r", number: 1, title: "visible", htmlUrl: "https://x/1", state: "open" },
    ]);

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 2,
      token: "tok",
    });

    const blockers = JSON.parse(getTask(task.id).blockedBy!);
    expect(blockers.some((b: { htmlUrl: string | null }) => b.htmlUrl === null)).toBe(true);
    expect(dependencyGate(getTask(task.id))).toBe("blocked");
  });

  // Hermes review, PR #669 — verified live that GitHub's own summary count
  // can lag after a dependency edge change even on an immediate re-fetch,
  // so a shortfall here can be a transient false positive rather than a
  // genuine token-scope gap. Not stamping blockedByCheckedAt on a shortfall
  // is what lets the very next sweep retry immediately instead of trusting
  // a possibly-wrong "blocked" verdict for the full 5-minute TTL.
  it("does not stamp blockedByCheckedAt when a shortfall is detected, so the next sweep retries immediately", async () => {
    const { task } = await createProjectAndTask({
      dependencyCount: 2,
      blockedBy: null,
      blockedByCheckedAt: null,
    });
    mockListBlockedByIssues.mockResolvedValue([
      { owner: "o", repo: "r", number: 1, title: "visible", htmlUrl: "https://x/1", state: "open" },
    ]);

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 2,
      token: "tok",
    });

    expect(getTask(task.id).blockedByCheckedAt).toBeNull();
  });

  it("does stamp blockedByCheckedAt on a clean (non-shortfall) result", async () => {
    const { task } = await createProjectAndTask({
      dependencyCount: 1,
      blockedBy: null,
      blockedByCheckedAt: null,
    });
    mockListBlockedByIssues.mockResolvedValue([
      { owner: "o", repo: "r", number: 1, title: "visible", htmlUrl: "https://x/1", state: "open" },
    ]);

    await refreshTaskBlockers(app, {
      taskId: task.id,
      projectId: task.projectId,
      owner: "o",
      repo: "r",
      issueNumber: 10,
      dependencyCount: 1,
      token: "tok",
    });

    expect(getTask(task.id).blockedByCheckedAt).not.toBeNull();
  });
});

describe("parseBlockedBy shape validation (Hermes review, PR #669)", () => {
  it("rejects an array whose items don't match StoredBlocker's shape", () => {
    expect(parseBlockedBy(JSON.stringify([{ owner: "o", repo: "r" }]))).toBeNull();
    expect(
      parseBlockedBy(
        JSON.stringify([{ owner: "o", repo: "r", number: "5", title: "t", htmlUrl: null }]),
      ),
    ).toBeNull();
  });

  it("accepts a well-formed array, including a synthetic entry with htmlUrl: null", () => {
    const blockers = [
      { owner: "o", repo: "r", number: 5, title: "t", htmlUrl: "https://x/5" },
      {
        owner: "o",
        repo: "r",
        number: 0,
        title: "1 blocker(s) not visible to this token",
        htmlUrl: null,
      },
    ];
    expect(parseBlockedBy(JSON.stringify(blockers))).toEqual(blockers);
  });
});

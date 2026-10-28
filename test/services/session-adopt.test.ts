// Must come before any import that could itself load "node-pty" /
// "node:child_process" — see test/helpers/mock-pty.ts's header comment.
import { plainNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import type * as ChildProcess from "node:child_process";
import { buildTestApp } from "../helpers/app.js";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { adoptSurvivingSession } from "../../src/services/session-adopt.js";
import type { SessionLiveness } from "../../src/services/session-process.js";

const ptyMock = plainNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
// Every systemd-run / dtach / systemctl call is faked (AGENTS.md invariant: no
// test may start a real scope). Adoption must not need one anyway — these
// tests assert getOrCreate is the only thing that would.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

type App = Awaited<ReturnType<typeof buildTestApp>>;

/** A project and one session row for it; `over` lets a test bend the row. */
function seed(app: App, over: Partial<typeof sessions.$inferInsert> = {}) {
  const [project] = app.db.insert(projects).values({ name: "p", cwd: "/work/p" }).returning().all();
  const [row] = app.db
    .insert(sessions)
    .values({ projectId: project.id, command: "claude", ...over })
    .returning()
    .all();
  return { project, row, id: String(row.id) };
}

/** Pretends PtyManager is told about the session: `get()` answers a live one. */
function stubAdoptable(app: App, liveness: SessionLiveness) {
  const tracked = new Set<string>();
  vi.spyOn(app.pty, "get").mockImplementation(((key: string) =>
    tracked.has(key) ? { isAlive: true } : undefined) as unknown as typeof app.pty.get);
  const isMasterAliveState = vi.spyOn(app.pty, "isMasterAliveState").mockResolvedValue(liveness);
  const getOrCreate = vi.spyOn(app.pty, "getOrCreate").mockImplementation(((opts: {
    id: string;
  }) => {
    tracked.add(opts.id);
    return {};
  }) as unknown as typeof app.pty.getOrCreate);
  return { isMasterAliveState, getOrCreate, tracked };
}

describe("adoptSurvivingSession (issue #2271)", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("reattaches a session whose scope is alive, from its stored cwd/command/env", async () => {
    const app = await buildTestApp();
    const { id } = seed(app, { cwd: "/work/p/wt", env: JSON.stringify({ FOO: "bar" }) });
    const { getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("adopted");

    expect(getOrCreate).toHaveBeenCalledTimes(1);
    expect(getOrCreate).toHaveBeenCalledWith({
      id,
      cwd: "/work/p/wt",
      command: "claude",
      cols: 80,
      rows: 24,
      env: { FOO: "bar" },
    });
  });

  it("falls back to the project's cwd when the session has none of its own", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "alive");

    await adoptSurvivingSession(app, id);

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/p" }));
  });

  it("never respawns a session whose scope is gone", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "dead");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("treats an unverifiable scope as retryable, never as dead", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "unknown");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("unverifiable");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("leaves a session PtyManager already tracks alone", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { isMasterAliveState, getOrCreate, tracked } = stubAdoptable(app, "alive");
    tracked.add(id);

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("live");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["killed", "exited"] as const)("does not adopt a %s session", async (status) => {
    const app = await buildTestApp();
    const { id } = seed(app, { status });
    const { isMasterAliveState, getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it.each(["9999", "not-a-number"])(
    "answers not-running for an id with no row (%s)",
    async (id) => {
      const app = await buildTestApp();
      const { getOrCreate } = stubAdoptable(app, "alive");

      await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

      expect(getOrCreate).not.toHaveBeenCalled();
    },
  );

  it("leaves a session on another host to that host's own PtyManager", async () => {
    const app = await buildTestApp();
    app.db.insert(hosts).values({ id: "box", name: "box" }).run();
    const { id } = seed(app, { hostId: "box" });
    const { isMasterAliveState, getOrCreate } = stubAdoptable(app, "alive");

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("not-running");

    expect(isMasterAliveState).not.toHaveBeenCalled();
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("shares one adoption between concurrent callers", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate } = stubAdoptable(app, "alive");

    const results = await Promise.all([
      adoptSurvivingSession(app, id),
      adoptSurvivingSession(app, id),
      adoptSurvivingSession(app, id),
    ]);

    expect(results).toEqual(["adopted", "adopted", "adopted"]);
    expect(getOrCreate).toHaveBeenCalledTimes(1);
  });

  it("yields to a terminal attach that won the race during the liveness read", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { getOrCreate, tracked } = stubAdoptable(app, "alive");
    vi.spyOn(app.pty, "isMasterAliveState").mockImplementation(async () => {
      tracked.add(id);
      return "alive";
    });

    await expect(adoptSurvivingSession(app, id)).resolves.toBe("live");

    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("reports unverifiable when the reattach never produces a live process", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    stubAdoptable(app, "alive");
    // getOrCreate "succeeds" but the session never becomes alive.
    vi.spyOn(app.pty, "getOrCreate").mockReturnValue({} as ReturnType<typeof app.pty.getOrCreate>);
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });

    const outcome = adoptSurvivingSession(app, id);
    await vi.advanceTimersByTimeAsync(6000);

    await expect(outcome).resolves.toBe("unverifiable");
  });

  it("starts a fresh adoption after the previous one settled", async () => {
    const app = await buildTestApp();
    const { id } = seed(app);
    const { isMasterAliveState } = stubAdoptable(app, "dead");

    await adoptSurvivingSession(app, id);
    await adoptSurvivingSession(app, id);

    expect(isMasterAliveState).toHaveBeenCalledTimes(2);
  });
});

// Issue #3194 — the retry's HOST decision, branch by branch.
//
// task-retry-host.ts is the module that answers "where does this retry run?".
// It has three answers — resume on the original host, re-place on another
// host, or wait for the original host — and every one of them has a "not
// quite" variant that has to land on the SAFE answer:
//
//   - the original host is parked, not just offline;
//   - the branch cannot be CONFIRMED on origin (no repo ref, no token, a
//     rate limit, a network error) — that is never a yes;
//   - the task's requirement (a `Host:`, a `Platform:`, a `Capability:`) does
//     not hold on the host that would otherwise take the retry.
//
// The tests below drive `decideRetryHost`/`branchOnOrigin` directly against a
// real app, because those branches are about WHAT the decision is, not about
// the route that shows it (test/routes/tasks-retry-replace.test.ts covers the
// route, the dispatch sweep and the "Start fresh" action).
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import type { PlacementTarget } from "../../src/services/placement.js";

vi.mock("../../src/services/task-github-sync.js", () => ({
  syncTaskTransition: vi.fn().mockResolvedValue(undefined),
}));

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const { tasks, projects, sessions, hosts } = await import("../../src/db/schema.js");
const hostGitModule = await import("../../src/services/host-git.js");
const githubIntegrationModule = await import("../../src/services/github-integration.js");
const githubRequestModule = await import("../../src/services/github-request.js");
const { GitHubApiError } = await import("../../src/services/github-fetch.js");
const { decideRetryHost, branchOnOrigin } = await import("../../src/services/task-retry-host.js");

const tmpDb = path.join(os.tmpdir(), `task-retry-host-test-${process.pid}.db`);
const MAC_CWD = "/Users/dev/proj";
const LINUX_CWD = "/srv/dev/proj";
const BRANCH = "mullion/task-9100-retry-host";

type App = Awaited<ReturnType<typeof buildApp>>;

describe("decideRetryHost — where a retry runs (#3194)", () => {
  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
    process.env.MULLION_TASK_MASTER_ENABLED = "true";
  });

  afterAll(async () => {
    await closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
    delete process.env.MULLION_TASK_MASTER_ENABLED;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** A remote host, online unless told otherwise. */
  async function addHost(
    app: App,
    name: string,
    platform: string,
    opts: { online?: boolean; drained?: boolean; capabilities?: string[] } = {},
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    app.db
      .update(hosts)
      .set({ platform, drained: opts.drained ?? false })
      .where(eq(hosts.id, hostId))
      .run();
    if (opts.online !== false) {
      app.hostHeartbeatTracker?.recordSuccess(hostId);
      app.hostCapacityTracker?.record(hostId, {
        platform,
        logicalCores: 8,
        loadAverage1m: 1,
        memory: { totalBytes: 1000, freeBytes: 500 },
        sessions: { tracked: 0, alive: 0 },
      });
    } else {
      app.hostHeartbeatTracker?.markOffline(hostId);
    }
    if (opts.capabilities) {
      app.hostAgentTracker?.record(hostId, {
        agents: ["claude"],
        capabilities: opts.capabilities,
        mullionVersion: "1.0.0",
      });
    }
    return hostId;
  }

  /**
   * A project mapped on both hosts, with a failed task whose worker ran on
   * the Mac — the host that holds the preserved branch.
   */
  async function setup(
    name: string,
    opts: {
      originalOnline?: boolean;
      originalDrained?: boolean;
      originalCapabilities?: string[];
      replacementOnline?: boolean;
      /** How the "is the branch on origin?" check answers. */
      origin: "yes" | "no" | "no-repo" | "no-token" | "rate-limited";
      replacementCapabilities?: string[];
    },
  ) {
    const app = await buildApp();
    app.db.delete(sessions).run();
    app.db.delete(tasks).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).run();

    const mac = await addHost(app, `${name}-mac`, "darwin", {
      online: opts.originalOnline !== false,
      drained: opts.originalDrained ?? false,
      capabilities: opts.originalCapabilities,
    });
    const linux = await addHost(app, `${name}-linux`, "linux", {
      online: opts.replacementOnline !== false,
      capabilities: opts.replacementCapabilities,
    });
    const [project] = app.db
      .insert(projects)
      .values({
        name,
        cwd: LINUX_CWD,
        hostId: linux,
        placement: "auto",
        hostCwds: JSON.stringify({ [mac]: MAC_CWD, [linux]: LINUX_CWD }),
      })
      .returning()
      .all();
    const [task] = app.db
      .insert(tasks)
      .values({
        projectId: project.id,
        title: "retry host decision",
        status: "failed",
        branchName: BRANCH,
        failureReason: "budget exceeded",
      })
      .returning()
      .all();
    const [worker] = app.db
      .insert(sessions)
      .values({
        projectId: project.id,
        taskId: task.id,
        name: `Task #${task.id} · worker`,
        command: "claude",
        hostId: mac,
        status: "exited",
      })
      .returning()
      .all();
    app.db.update(tasks).set({ sessionId: worker.id }).where(eq(tasks.id, task.id)).run();

    // The GitHub side of the confirmation. Each case is a DIFFERENT way the
    // answer can fail to be a positive one — and every one of them must
    // count as "not on origin".
    vi.spyOn(hostGitModule, "resolveRepoRef").mockImplementation(async () => {
      if (opts.origin === "no-repo") return null;
      return { owner: "o", repo: "r" };
    });
    vi.spyOn(githubIntegrationModule, "resolveGitHubToken").mockImplementation(async () => {
      if (opts.origin === "no-token") return null;
      return "tok";
    });
    vi.spyOn(githubRequestModule, "githubRequest").mockImplementation(async () => {
      if (opts.origin === "no") throw new GitHubApiError("Not Found", 404);
      if (opts.origin === "rate-limited") throw new GitHubApiError("rate limited", 403);
      return { ref: `refs/heads/${BRANCH}` } as never;
    });

    return { app, mac, linux, project, task };
  }

  async function decide(
    app: App,
    task: typeof tasks.$inferSelect,
    project: typeof projects.$inferSelect,
    opts: {
      originalHostId: string;
      requirement?: PlacementTarget | null;
      requiredAgent?: readonly string[];
    },
  ) {
    return await decideRetryHost(app, {
      task,
      project,
      requirement: opts.requirement ?? null,
      requiredAgent: opts.requiredAgent ?? ["claude"],
      originalHostId: opts.originalHostId,
    });
  }

  it("resumes on the original host while it is online", async () => {
    const { app, mac, project, task } = await setup("host-resume", { origin: "no" });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision).toEqual({ kind: "resume", hostId: mac });
    } finally {
      await app.close();
    }
  });

  it("treats a PARKED original host as unavailable, not as a host to resume on", async () => {
    const { app, mac, linux, project, task } = await setup("host-parked", {
      origin: "yes",
      originalOnline: false,
      originalDrained: true,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      // A parked host takes no new work, so the retry does not resume there.
      // The branch IS on origin, so it moves to the eligible host instead.
      expect(decision.kind).toBe("replace");
      expect(decision.kind === "replace" && decision.hostId).toBe(linux);
    } finally {
      await app.close();
    }
  });

  it("waits for a PARKED original host when the branch is not on origin", async () => {
    const { app, mac, project, task } = await setup("host-parked-no-origin", {
      origin: "no",
      originalOnline: false,
      originalDrained: true,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      // The branch is only on the parked host, so there is nowhere else to go.
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.hostId).toBe(mac);
      expect(decision.kind === "wait" && decision.detail).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("re-places onto another host only when the branch is CONFIRMED on origin", async () => {
    const { app, mac, linux, project, task } = await setup("host-replace", {
      origin: "yes",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("replace");
      expect(decision.kind === "replace" && decision.hostId).toBe(linux);
    } finally {
      await app.close();
    }
  });

  it("waits (never re-places) when the branch is not on origin", async () => {
    const { app, mac, project, task } = await setup("host-not-origin", {
      origin: "no",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.hostId).toBe(mac);
      expect(decision.kind === "wait" && decision.detail).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("never re-places when the branch cannot be confirmed: no repo ref", async () => {
    const { app, mac, project, task } = await setup("host-no-repo", {
      origin: "no-repo",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.detail).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("never re-places when the branch cannot be confirmed: no token", async () => {
    const { app, mac, project, task } = await setup("host-no-token", {
      origin: "no-token",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.detail).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("never re-places when the branch lookup fails for a reason that is not a 404", async () => {
    const { app, mac, project, task } = await setup("host-rate-limited", {
      origin: "rate-limited",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.detail).toContain("not on origin");
    } finally {
      await app.close();
    }
  });

  it("waits when no other host is eligible at all", async () => {
    const { app, mac, project, task } = await setup("host-no-candidate", {
      origin: "yes",
      originalOnline: false,
      replacementOnline: false,
    });
    try {
      const decision = await decide(app, task, project, { originalHostId: mac });
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.detail).toContain("no other host");
    } finally {
      await app.close();
    }
  });

  it("never resumes on a host the task's Host: directive does not name", async () => {
    const { app, mac, linux, project, task } = await setup("host-directive", {
      origin: "yes",
      originalOnline: false,
    });
    try {
      // The task asks for the Linux host, but its worker ran on the Mac: the
      // requirement is a HARD one on every path, so the Mac cannot take the
      // retry even though it holds the preserved branch.
      const decision = await decide(app, task, project, {
        originalHostId: mac,
        requirement: { hostId: linux },
      });
      expect(decision.kind).toBe("replace");
      expect(decision.kind === "replace" && decision.hostId).toBe(linux);
    } finally {
      await app.close();
    }
  });

  it("never resumes on a host of another platform", async () => {
    const { app, mac, project, task } = await setup("host-platform", {
      origin: "yes",
      originalOnline: false,
    });
    try {
      const decision = await decide(app, task, project, {
        originalHostId: mac,
        requirement: { platform: "linux" },
      });
      // The Mac is darwin and the requirement is linux, so the retry cannot
      // resume there; the only linux host is eligible, so it moves there.
      expect(decision.kind).toBe("replace");
    } finally {
      await app.close();
    }
  });

  it("never re-places onto a host that lacks a required capability", async () => {
    const { app, mac, linux, project, task } = await setup("host-capability", {
      origin: "yes",
      originalOnline: false,
      originalCapabilities: [],
      replacementCapabilities: [],
    });
    try {
      const decision = await decide(app, task, project, {
        originalHostId: mac,
        requirement: { capabilities: ["xcode"] },
      });
      // Neither host reports the capability, so neither may take it: the
      // retry waits for the original host rather than landing somewhere that
      // cannot do the work.
      expect(decision.kind).toBe("wait");
      expect(decision.kind === "wait" && decision.hostId).toBe(mac);
      expect(decision.kind === "wait" && decision.detail).not.toContain(linux);
    } finally {
      await app.close();
    }
  });

  it("branchOnOrigin is false for an empty branch name", async () => {
    const { app, project } = await setup("host-empty-branch", { origin: "yes" });
    try {
      expect(await branchOnOrigin(app, project, "")).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("branchOnOrigin is false when the project has no GitHub remote at all", async () => {
    const { app, project } = await setup("host-remote", { origin: "no-repo" });
    try {
      expect(await branchOnOrigin(app, project, BRANCH)).toBe(false);
    } finally {
      await app.close();
    }
  });
});

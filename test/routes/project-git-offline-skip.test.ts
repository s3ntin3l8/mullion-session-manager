// Issue #2991: the batch git polls and GET /api/projects do not ask a host the
// heartbeat has marked offline — a dead host used to cost a request (and a
// request timeout) per id on every poll. Only `offline` skips: a host that is
// still `pending` (never checked) or online is asked as before.

import { afterEach, describe, expect, it, vi } from "vitest";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import * as remoteHostClient from "../../src/services/remote-host-client.js";
import { resetHostWarnThrottle } from "../../src/services/host-warn-throttle.js";

type Client = Record<string, ReturnType<typeof vi.fn>>;

function stubClient(client: Client) {
  return vi
    .spyOn(remoteHostClient, "getRemoteHostClient")
    .mockReturnValue(client as unknown as remoteHostClient.RemoteHostClient);
}

let seq = 0;

async function seed(app: Awaited<ReturnType<typeof buildApp>>) {
  // The heartbeat tracker is created in the app's onReady hook (and, with the
  // test env's HOST_HEARTBEAT_INTERVAL_SECONDS=0, never swept), so make the app
  // ready first; a tracker assigned earlier would be replaced by it.
  await app.ready();
  const hostId = `off-host-${++seq}`;
  app.db.insert(hosts).values({ id: hostId, name: hostId, baseUrl: "http://127.0.0.1:1" }).run();
  const projectId = app.db
    .insert(projects)
    .values({ name: `off-p-${seq}`, cwd: `/remote/off-${seq}`, hostId })
    .returning({ id: projects.id })
    .get().id;
  const sessionId = app.db
    .insert(sessions)
    .values({ projectId, command: "bash", status: "active", hostId, cwd: "/remote/x" })
    .returning({ id: sessions.id })
    .get().id;
  return { hostId, projectId, sessionId, cwd: `/remote/off-${seq}` };
}

const STATUS = { isRepo: true, status: { branch: "main", isClean: true, files: [] } };
const DIFF = { isRepo: true, stats: { filesChanged: 1, insertions: 2, deletions: 3 } };

describe("batch git polls skip an offline host (#2991)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetHostWarnThrottle();
  });

  it("an offline host is not asked, and its ids are omitted", async () => {
    const app = await buildApp();
    try {
      const { hostId, projectId, sessionId } = await seed(app);
      app.hostHeartbeatTracker?.markOffline(hostId);
      const client: Client = {
        resolveGitStatus: vi.fn().mockResolvedValue(STATUS),
        resolveGitDiffStats: vi.fn().mockResolvedValue(DIFF),
      };
      stubClient(client);

      const statuses = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${sessionId}`,
      });
      expect(statuses.json()).toMatchObject({ projects: {}, sessions: {} });
      const diffs = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(diffs.json()).toEqual({});
      expect(client.resolveGitStatus).not.toHaveBeenCalled();
      expect(client.resolveGitDiffStats).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("a host that is not yet checked (pending) is still asked", async () => {
    const app = await buildApp();
    try {
      const { projectId, sessionId } = await seed(app);
      const client: Client = {
        resolveGitStatus: vi.fn().mockResolvedValue(STATUS),
        resolveGitDiffStats: vi.fn().mockResolvedValue(DIFF),
      };
      stubClient(client);

      const statuses = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${sessionId}`,
      });
      const body = statuses.json() as { projects: object; sessions: object };
      expect(Object.keys(body.projects)).toHaveLength(1);
      expect(Object.keys(body.sessions)).toHaveLength(1);
      await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${sessionId}`,
      });
      expect(client.resolveGitDiffStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("an online host is asked, and asked again once it recovers from offline", async () => {
    const app = await buildApp();
    try {
      const { hostId, sessionId } = await seed(app);
      const client: Client = { resolveGitDiffStats: vi.fn().mockResolvedValue(DIFF) };
      stubClient(client);
      const url = `/api/projects/git-diff-stats?sessionIds=${sessionId}`;

      app.hostHeartbeatTracker?.markOffline(hostId);
      await app.inject({ method: "GET", url });
      expect(client.resolveGitDiffStats).not.toHaveBeenCalled();

      app.hostHeartbeatTracker?.recordSuccess(hostId);
      const res = await app.inject({ method: "GET", url });
      expect(Object.keys(res.json() as object)).toHaveLength(1);
      expect(client.resolveGitDiffStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

describe("GET /api/projects skips an offline remote host (#2991)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not ask for currentBranch / ruleFiles, and degrades them as a failed call would", async () => {
    const app = await buildApp();
    try {
      const { hostId, projectId, cwd } = await seed(app);
      app.hostHeartbeatTracker?.markOffline(hostId);
      const client: Client = {
        resolveGitBranch: vi.fn().mockResolvedValue("main"),
        resolveExistingRuleFileNames: vi.fn().mockResolvedValue(["CLAUDE.md"]),
      };
      stubClient(client);

      const res = await app.inject({ method: "GET", url: "/api/projects" });
      const row = (
        res.json() as Array<{ id: number; currentBranch: unknown; ruleFiles: unknown }>
      ).find((p) => p.id === projectId);
      expect(row).toMatchObject({ currentBranch: null, ruleFiles: [] });
      // Other remote projects seeded by earlier tests are still asked; this
      // project's own cwd must not be.
      const askedCwds = [
        ...client.resolveGitBranch.mock.calls,
        ...client.resolveExistingRuleFileNames.mock.calls,
      ].map(([c]) => c);
      expect(askedCwds).not.toContain(cwd);
    } finally {
      await app.close();
    }
  });

  it("still asks a host that is not offline", async () => {
    const app = await buildApp();
    try {
      const { projectId } = await seed(app);
      const client: Client = {
        resolveGitBranch: vi.fn().mockResolvedValue("main"),
        resolveExistingRuleFileNames: vi.fn().mockResolvedValue(["CLAUDE.md"]),
      };
      stubClient(client);

      const res = await app.inject({ method: "GET", url: "/api/projects" });
      const row = (
        res.json() as Array<{ id: number; currentBranch: unknown; ruleFiles: unknown }>
      ).find((p) => p.id === projectId);
      expect(row).toMatchObject({ currentBranch: "main", ruleFiles: ["CLAUDE.md"] });
    } finally {
      await app.close();
    }
  });
});

// Issue #2991: a batch request naming many sessions that share one remote
// (host, cwd) asks the agent once, not once per session — and a dead host is
// tried once per batch, with every id still omitted.

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hosts, projects, sessions } from "../../src/db/schema.js";
import { buildApp } from "../../src/app.js";
import { HostUnreachableError } from "../../src/services/remote-host-errors.js";
import * as remoteHostClient from "../../src/services/remote-host-client.js";
import { resetHostWarnThrottle } from "../../src/services/host-warn-throttle.js";

type Client = Record<string, ReturnType<typeof vi.fn>>;

function stubClient(client: Client) {
  return vi
    .spyOn(remoteHostClient, "getRemoteHostClient")
    .mockReturnValue(client as unknown as remoteHostClient.RemoteHostClient);
}

let seq = 0;

async function seed(app: Awaited<ReturnType<typeof buildApp>>, cwds: string[]) {
  const hostId = `dd-host-${++seq}`;
  app.db.insert(hosts).values({ id: hostId, name: hostId, baseUrl: "http://127.0.0.1:1" }).run();
  const projectId = app.db
    .insert(projects)
    .values({ name: "dd-p", cwd: "/remote/proj", hostId })
    .returning({ id: projects.id })
    .get().id;
  return cwds.map(
    (cwd) =>
      app.db
        .insert(sessions)
        .values({ projectId, command: "bash", status: "exited", hostId, cwd })
        .returning({ id: sessions.id })
        .get().id,
  );
}

const STATUS = { isRepo: true, status: { branch: "main", isClean: true, files: [] } };
const DIFF = { isRepo: true, stats: { filesChanged: 1, insertions: 2, deletions: 3 } };

describe("batch git routes: one remote call per (host, cwd)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    resetHostWarnThrottle();
  });

  it("git-statuses asks the agent once for sessions sharing a cwd", async () => {
    const app = await buildApp();
    try {
      const ids = await seed(app, ["/remote/a", "/remote/a", "/remote/a", "/remote/b"]);
      const client: Client = { resolveGitStatus: vi.fn().mockResolvedValue(STATUS) };
      stubClient(client);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${ids.join(",")}`,
      });
      const body = res.json() as { sessions: Record<string, unknown> };
      expect(Object.keys(body.sessions)).toHaveLength(4);
      expect(client.resolveGitStatus).toHaveBeenCalledTimes(2);
      expect(client.resolveGitStatus.mock.calls.map(([cwd]) => cwd).sort()).toEqual([
        "/remote/a",
        "/remote/b",
      ]);
    } finally {
      await app.close();
    }
  });

  it("git-statuses also collapses the project row into its sessions' cwd", async () => {
    const app = await buildApp();
    try {
      const ids = await seed(app, ["/remote/proj", "/remote/proj"]);
      const projectId = app.db
        .select({ projectId: sessions.projectId })
        .from(sessions)
        .where(eq(sessions.id, ids[0]))
        .get()!.projectId;
      const client: Client = { resolveGitStatus: vi.fn().mockResolvedValue(STATUS) };
      stubClient(client);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?ids=${projectId}&sessionIds=${ids.join(",")}`,
      });
      const body = res.json() as { projects: Record<string, unknown>; sessions: object };
      expect(Object.keys(body.projects)).toHaveLength(1);
      expect(Object.keys(body.sessions)).toHaveLength(2);
      expect(client.resolveGitStatus).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("git-diff-stats asks the agent once per (cwd, base)", async () => {
    const app = await buildApp();
    try {
      const ids = await seed(app, ["/remote/a", "/remote/a", "/remote/a"]);
      const client: Client = { resolveGitDiffStats: vi.fn().mockResolvedValue(DIFF) };
      stubClient(client);
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${ids.join(",")}&base=AUTO`,
      });
      expect(Object.keys(res.json() as object)).toHaveLength(3);
      expect(client.resolveGitDiffStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });

  it("an unreachable host is tried once per batch and every id is omitted", async () => {
    const app = await buildApp();
    try {
      const ids = await seed(app, ["/remote/a", "/remote/a", "/remote/a"]);
      const client: Client = {
        resolveGitStatus: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("dd-host-x", new Error("down"))),
        resolveGitDiffStats: vi
          .fn()
          .mockRejectedValue(new HostUnreachableError("dd-host-x", new Error("down"))),
      };
      stubClient(client);
      const statuses = await app.inject({
        method: "GET",
        url: `/api/projects/git-statuses?sessionIds=${ids.join(",")}`,
      });
      expect((statuses.json() as { sessions: object }).sessions).toEqual({});
      const diffs = await app.inject({
        method: "GET",
        url: `/api/projects/git-diff-stats?sessionIds=${ids.join(",")}`,
      });
      expect(diffs.json()).toEqual({});
      expect(client.resolveGitStatus).toHaveBeenCalledTimes(1);
      expect(client.resolveGitDiffStats).toHaveBeenCalledTimes(1);
    } finally {
      await app.close();
    }
  });
});

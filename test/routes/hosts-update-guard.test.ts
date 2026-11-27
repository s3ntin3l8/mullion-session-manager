import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { projects, sessions, tasks } from "../../src/db/schema.js";
import { appVersion } from "../../src/routes/server-info.js";
import { clearUpdateCheckCacheForTests } from "../../src/services/update-checker.js";
import { seedHostResponse } from "../helpers/hosts.js";

const tmpDb = path.join(os.tmpdir(), `hosts-update-guard-test-${process.pid}.db`);

describe("POST /api/hosts/:id/update/apply Task Master guard (issue #3180)", () => {
  const realFetch = globalThis.fetch;
  let githubResponses: Response[];

  beforeAll(() => {
    fs.rmSync(tmpDb, { force: true });
    process.env.DATABASE_URL = `file:${tmpDb}`;
  });

  afterAll(() => {
    closeDb();
    fs.rmSync(tmpDb, { force: true });
    delete process.env.DATABASE_URL;
  });

  beforeEach(() => {
    githubResponses = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (new URL(url).hostname === "api.github.com") {
          const next = githubResponses.shift();
          if (!next) throw new Error("unexpected GitHub API call in test");
          return Promise.resolve(next);
        }
        return realFetch(input, init);
      }),
    );
    clearUpdateCheckCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function jsonResponse(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  async function startStubAgent(
    routes: Record<string, { status: number; body: unknown }>,
  ): Promise<{ baseUrl: string; calls: string[]; close: () => Promise<void> }> {
    const calls: string[] = [];
    const server = http.createServer((req, res) => {
      const reqPath = (req.url ?? "").split("?")[0];
      calls.push(reqPath);
      const route = routes[reqPath];
      if (!route) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ message: "no such route" }));
        return;
      }
      res.writeHead(route.status, { "content-type": "application/json" });
      res.end(JSON.stringify(route.body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected a real bound address");
    }
    return {
      baseUrl: `http://127.0.0.1:${address.port}`,
      calls,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  }

  it("refuses with 409 when claimed, in_progress, or reviewing tasks run on the host unless ?force=true", async () => {
    const agent = await startStubAgent({
      "/internal/config": {
        status: 200,
        body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
      },
      "/internal/updates/apply": {
        status: 202,
        body: { phase: "downloading", version: appVersion },
      },
    });
    githubResponses.push(
      jsonResponse(200, {
        tag_name: `v${appVersion}`,
        html_url: "https://x",
        assets: [
          {
            name: `mullion-${appVersion}.tgz`,
            browser_download_url: "https://github.com/x/y/a.tgz",
          },
          {
            name: `mullion-${appVersion}.tgz.sha256`,
            browser_download_url: "https://github.com/x/y/a.tgz.sha256",
          },
        ],
      }),
    );

    const app = await buildApp();
    try {
      const created = await seedHostResponse(app, {
        name: "worker-guard-agent",
        baseUrl: agent.baseUrl,
        token: "t",
      });
      const { id: hostId } = created.json();

      const [targetProject] = app.db
        .insert(projects)
        .values({ name: "branchdam-mobile", cwd: "/tmp/bm", hostId })
        .returning()
        .all();
      const [otherProject] = app.db
        .insert(projects)
        .values({ name: "other-proj", cwd: "/tmp/other", hostId: "local" })
        .returning()
        .all();

      // Plain interactive session on target host must NOT block.
      app.db
        .insert(sessions)
        .values({
          projectId: targetProject.id,
          hostId,
          command: "claude",
          cwd: "/tmp/bm",
        })
        .run();

      // Tasks on another host and non-active tasks on target host must NOT block.
      for (const [idx, status] of (["ready", "done", "failed"] as const).entries()) {
        app.db
          .insert(tasks)
          .values({
            projectId: targetProject.id,
            issueNumber: 100 + idx,
            title: `non-blocking-${status}`,
            status,
          })
          .run();
      }
      app.db
        .insert(tasks)
        .values({
          projectId: otherProject.id,
          issueNumber: 101,
          title: "other-host-task",
          status: "in_progress",
        })
        .run();

      // Each of claimed, in_progress, reviewing on target host MUST block.
      for (const [idx, status] of (["claimed", "in_progress", "reviewing"] as const).entries()) {
        const [insertedTask] = app.db
          .insert(tasks)
          .values({
            projectId: targetProject.id,
            issueNumber: 270 + idx,
            title: `blocking-${status}`,
            status,
          })
          .returning()
          .all();

        const blocked = await app.inject({
          method: "POST",
          url: `/api/hosts/${hostId}/update/apply`,
        });
        expect(blocked.statusCode).toBe(409);
        expect(blocked.json()).toEqual({
          error: expect.stringContaining("Task Master"),
          tasks: [
            {
              id: insertedTask.id,
              issueNumber: 270 + idx,
              projectName: "branchdam-mobile",
              status,
            },
          ],
        });
        expect(agent.calls).not.toContain("/internal/updates/apply");

        app.db.delete(tasks).where(eq(tasks.id, insertedTask.id)).run();
      }

      // Re-insert one blocking task and verify ?force=true overrides it and logs a warning.
      const insertedForced = app.db
        .insert(tasks)
        .values({
          projectId: targetProject.id,
          issueNumber: 274,
          title: "forced-task",
          status: "in_progress",
        })
        .returning({ id: tasks.id })
        .get();

      const warnSpy = vi.spyOn(app.log, "warn");
      const forced = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/update/apply?force=true`,
      });
      expect(forced.statusCode).toBe(202);
      expect(agent.calls).toContain("/internal/updates/apply");
      expect(warnSpy).toHaveBeenCalledWith(
        {
          hostId,
          taskIds: [insertedForced.id],
          statuses: ["in_progress"],
        },
        "force-updating a host with running Task Master tasks",
      );
    } finally {
      await app.close();
      await agent.close();
    }
  });

  it("allows update when only interactive sessions or non-blocking tasks exist on the host", async () => {
    const agent = await startStubAgent({
      "/internal/config": {
        status: 200,
        body: { role: "agent", version: "0.0.1", projectsRoots: [], sessionsDir: "/x" },
      },
      "/internal/updates/apply": {
        status: 202,
        body: { phase: "downloading", version: appVersion },
      },
    });
    githubResponses.push(
      jsonResponse(200, {
        tag_name: `v${appVersion}`,
        html_url: "https://x",
        assets: [
          {
            name: `mullion-${appVersion}.tgz`,
            browser_download_url: "https://github.com/x/y/a.tgz",
          },
          {
            name: `mullion-${appVersion}.tgz.sha256`,
            browser_download_url: "https://github.com/x/y/a.tgz.sha256",
          },
        ],
      }),
    );

    const app = await buildApp();
    try {
      const created = await seedHostResponse(app, {
        name: "idle-tasks-agent",
        baseUrl: agent.baseUrl,
        token: "t",
      });
      const { id: hostId } = created.json();

      const [targetProject] = app.db
        .insert(projects)
        .values({ name: "idle-proj", cwd: "/tmp/idle", hostId })
        .returning()
        .all();

      app.db
        .insert(sessions)
        .values({
          projectId: targetProject.id,
          hostId,
          command: "claude",
          cwd: "/tmp/idle",
        })
        .run();

      for (const [idx, status] of (["ready", "done", "failed"] as const).entries()) {
        app.db
          .insert(tasks)
          .values({
            projectId: targetProject.id,
            issueNumber: 300 + idx,
            title: `task-${status}`,
            status,
          })
          .run();
      }

      const warnSpy = vi.spyOn(app.log, "warn");
      const res = await app.inject({
        method: "POST",
        url: `/api/hosts/${hostId}/update/apply`,
      });
      expect(res.statusCode).toBe(202);
      expect(agent.calls).toContain("/internal/updates/apply");
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        "force-updating a host with running Task Master tasks",
      );
    } finally {
      await app.close();
      await agent.close();
    }
  });
});

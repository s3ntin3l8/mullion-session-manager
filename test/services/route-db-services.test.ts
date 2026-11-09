import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { ne } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { closeDb } from "../../src/db/client.js";
import { hosts, integrations, projects, sessions, tasks } from "../../src/db/schema.js";
import {
  deleteProjectRows,
  listHostProjects,
  listProjectSessions,
} from "../../src/services/host-registry.js";
import {
  getLocalProject,
  getProjectCheckout,
  getProjectRow,
  listActiveLocalSessionEnvs,
  listLocalProjects,
} from "../../src/services/session-host.js";
import { isGithubWebhookEnabled } from "../../src/services/github-integration.js";
import {
  getPreviewTarget,
  readProjectPreviewTargets,
  saveProjectPreviewTargets,
} from "../../src/services/preview-registry.js";
import { listResumableTaskWorktrees } from "../../src/services/worktree-usage.js";
import { insertDemoTasks } from "../../src/services/demo-fixtures.js";

// Direct tests for the DB access that moved out of the host / preview /
// settings-side routes (issue #2819). Real DB, no mocks.

const tmpDb = path.join(os.tmpdir(), `route-db-services-test-${process.pid}.db`);

describe("route DB services (#2819)", () => {
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
    app.db.delete(tasks).run();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(integrations).run();
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
  });

  const addProject = (name: string, hostId?: string) =>
    app.db
      .insert(projects)
      .values({ name, cwd: `/tmp/${name}`, ...(hostId ? { hostId } : {}) })
      .returning()
      .get();

  it("project lookups return the row, checkout, and local-only views", () => {
    const local = addProject("loc");
    app.db
      .insert(hosts)
      .values({ id: "h2", name: "h2", role: "agent" } as never)
      .run();
    const remote = addProject("rem", "h2");

    expect(getProjectRow(app, local.id)?.name).toBe("loc");
    expect(getProjectRow(app, 9999)).toBeUndefined();
    expect(getProjectCheckout(app, remote.id)).toEqual({ cwd: "/tmp/rem", hostId: "h2" });
    expect(getProjectCheckout(app, 9999)).toBeUndefined();
    expect(listLocalProjects(app)).toEqual([{ id: local.id, name: "loc", cwd: "/tmp/loc" }]);
    expect(getLocalProject(app, local.id)?.name).toBe("loc");
    expect(getLocalProject(app, remote.id)).toBeUndefined();
  });

  it("listActiveLocalSessionEnvs returns only active local sessions with an env", () => {
    const p = addProject("envs");
    const base = { projectId: p.id, command: "bash", cwd: "/tmp" };
    app.db
      .insert(sessions)
      .values({ ...base, env: '{"A":"1"}' })
      .run();
    app.db
      .insert(sessions)
      .values({ ...base })
      .run();
    app.db
      .insert(sessions)
      .values({ ...base, env: '{"B":"2"}', status: "exited" } as never)
      .run();
    expect(listActiveLocalSessionEnvs(app)).toEqual(['{"A":"1"}']);
  });

  it("host project helpers list and delete rows (sessions cascade)", () => {
    app.db
      .insert(hosts)
      .values({ id: "h3", name: "h3", role: "agent" } as never)
      .run();
    const a = addProject("a", "h3");
    const b = addProject("b", "h3");
    addProject("other");
    app.db.insert(sessions).values({ projectId: a.id, command: "bash", cwd: "/tmp" }).run();

    expect(
      listHostProjects(app, "h3")
        .map((p) => p.name)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(listProjectSessions(app, a.id)).toHaveLength(1);
    expect(listProjectSessions(app, b.id)).toHaveLength(0);

    deleteProjectRows(app, [a.id, b.id]);
    expect(listHostProjects(app, "h3")).toEqual([]);
    expect(listProjectSessions(app, a.id)).toEqual([]);
    expect(listLocalProjects(app)).toHaveLength(1);
  });

  it("isGithubWebhookEnabled reflects the integration row, false when absent", () => {
    expect(isGithubWebhookEnabled(app)).toBe(false);
    app.db.insert(integrations).values({ provider: "github", webhookEnabled: true }).run();
    expect(isGithubWebhookEnabled(app)).toBe(true);
  });

  it("preview targets round-trip: read, save in order, drop the omitted, update in place", () => {
    const p = addProject("pt");
    expect(readProjectPreviewTargets(app, 9999)).toBeUndefined();
    expect(readProjectPreviewTargets(app, p.id)).toEqual({ devServerUrl: null, targets: [] });

    const t = (id: string) => ({
      id,
      name: id,
      destination: "http://127.0.0.1:1/",
      connectionOrigin: "project" as const,
    });
    saveProjectPreviewTargets(app, p.id, "3000", [t("b"), t("a")]);
    let read = readProjectPreviewTargets(app, p.id)!;
    expect(read.devServerUrl).toBe("3000");
    expect(read.targets.map((x) => x.id)).toEqual(["b", "a"]);
    expect(getPreviewTarget(app, "a")?.projectId).toBe(p.id);

    saveProjectPreviewTargets(app, p.id, null, [t("a")]);
    read = readProjectPreviewTargets(app, p.id)!;
    expect(read.devServerUrl).toBeNull();
    expect(read.targets.map((x) => [x.id, x.order])).toEqual([["a", 0]]);
    expect(getPreviewTarget(app, "b")).toBeUndefined();
  });

  it("listResumableTaskWorktrees returns worktree paths of live tasks only", () => {
    const p = addProject("wt");
    insertDemoTasks(app, [
      { projectId: p.id, title: "r", status: "in_progress", worktreePath: "/wt/r" },
      { projectId: p.id, title: "d", status: "done", worktreePath: "/wt/d" },
      { projectId: p.id, title: "n", status: "claimed" },
    ]);
    expect(listResumableTaskWorktrees(app)).toHaveLength(2);
    expect(listResumableTaskWorktrees(app)).toContain("/wt/r");
  });

  it("insertDemoTasks is all-or-nothing", () => {
    const p = addProject("demo");
    const ok = { projectId: p.id, title: "x", status: "ready", issueNumber: 7 };
    expect(() => insertDemoTasks(app, [ok, { ...ok, title: "dup" }])).toThrow();
    expect(app.db.select().from(tasks).all()).toHaveLength(0);
    expect(insertDemoTasks(app, [ok])).toHaveLength(1);
  });
});

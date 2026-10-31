import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import {
  browserCookies,
  devices,
  previews,
  projectPreviewTargets,
  projectTooling,
  projectUrls,
  projects,
  sessionBrowsers,
  sessions,
  tasks,
  webhookRegistrations,
} from "../../src/db/schema.js";
import { createHost } from "../../src/services/host-registry.js";
import { findDuplicateGroups, mergeProjects } from "../../src/services/project-merge.js";
import { parseHostCwds, serializeHostCwds } from "../../src/services/placement.js";
import { parseHostCwdsMeta } from "../../src/services/host-cwds-meta.js";
import { MAX_HOST_CWDS } from "../../src/shared/constants.js";
import * as taskEvents from "../../src/services/task-events.js";
import * as githubWebhook from "../../src/services/github-webhook.js";
import { localProject, mergeDiscovery, remoteProject } from "../helpers/merge-fixtures.js";

// Issue #2232 — real DB; only a remote host's discovery is faked.
vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => mergeDiscovery.get(hostId) ?? [],
    }),
  };
});

const OLD = new Date("2024-01-01T00:00:00Z");
const NEW = new Date("2025-01-01T00:00:00Z");

describe("project-merge", () => {
  let app: FastifyInstance;
  let tmp: string;
  let macId: string;
  let survivorId: number;
  let dupId: number;
  let dupCwd: string;

  function task(projectId: number, over: Partial<typeof tasks.$inferInsert> = {}) {
    return app.db
      .insert(tasks)
      .values({ projectId, title: "t", ...over })
      .returning()
      .get();
  }
  const merge = () => mergeProjects(app, { survivorId, duplicateId: dupId });

  beforeEach(async () => {
    mergeDiscovery.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "project-merge-"));
    app = await buildTestApp();
    await app.ready();
    app.db.delete(projects).run();
    macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
    survivorId = localProject(app, tmp, "app", OLD).id;
    dupCwd = "/Users/me/app";
    dupId = remoteProject(app, macId, "app-mac", dupCwd, NEW).id;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("findDuplicateGroups", () => {
    it("groups by origin with the oldest project as survivor", async () => {
      localProject(app, tmp, "other", OLD, "git@github.com:acme/other.git");
      localProject(app, tmp, "noorigin", OLD, null);
      const groups = await findDuplicateGroups(app);
      expect(groups).toHaveLength(1);
      expect(groups[0].survivor.id).toBe(survivorId);
      expect(groups[0].duplicates.map((d) => d.id)).toEqual([dupId]);
      expect(groups[0].duplicates[0].refusal).toBeNull();
    });

    it("breaks a createdAt tie by id and reports the refusal and counts", async () => {
      const sameHost = localProject(app, tmp, "app2", OLD);
      task(sameHost.id, { status: "in_progress" });
      const [g] = await findDuplicateGroups(app);
      expect(g.survivor.id).toBe(survivorId);
      const d = g.duplicates.find((x) => x.id === sameHost.id)!;
      expect(d.refusal?.code).toBe("SAME_HOST");
      expect(d.counts).toMatchObject({ tasks: 1, liveTasks: 1 });
    });

    it("finds nothing when no origin is shared", async () => {
      mergeDiscovery.set(macId, [
        { name: "x", cwd: dupCwd, isGitRepo: true, origin: "git@github.com:acme/else.git" },
      ]);
      expect(await findDuplicateGroups(app)).toEqual([]);
    });
  });

  describe("mergeProjects", () => {
    it("fills only null settings on the survivor", () => {
      app.db
        .update(projects)
        .set({ autoApprove: false, defaultAgent: "claude" })
        .where(eq(projects.id, survivorId))
        .run();
      app.db
        .update(projects)
        .set({
          autoApprove: true,
          defaultAgent: "codex",
          mergeOnApprove: true,
          maxAutoReturnRounds: 4,
          devServerUrl: "5173",
          injectAgentGuide: false,
          placement: "auto",
          placementConstraints: JSON.stringify({ platform: ["darwin"], allowBurst: false }),
        })
        .where(eq(projects.id, dupId))
        .run();
      expect(merge().ok).toBe(true);
      const s = app.db.select().from(projects).where(eq(projects.id, survivorId)).get()!;
      expect(s.autoApprove).toBe(false);
      expect(s.defaultAgent).toBe("claude");
      expect(s.mergeOnApprove).toBe(true);
      expect(s.maxAutoReturnRounds).toBe(4);
      expect(s.devServerUrl).toBe("5173");
      expect(s.injectAgentGuide).toBe(false);
      expect(s.placement).toBe("pinned");
      // Issue #2241 — the survivor had no steering flags, so it takes the duplicate's.
      expect(s.placementConstraints).toBe(
        JSON.stringify({ platform: ["darwin"], allowBurst: false }),
      );
    });

    it("keeps the survivor's own placement flags", () => {
      app.db
        .update(projects)
        .set({ placementConstraints: JSON.stringify({ platform: ["linux"], allowBurst: true }) })
        .where(eq(projects.id, survivorId))
        .run();
      app.db
        .update(projects)
        .set({ placementConstraints: JSON.stringify({ platform: ["darwin"], allowBurst: false }) })
        .where(eq(projects.id, dupId))
        .run();
      expect(merge().ok).toBe(true);
      const s = app.db.select().from(projects).where(eq(projects.id, survivorId)).get()!;
      expect(s.placementConstraints).toBe(
        JSON.stringify({ platform: ["linux"], allowBurst: true }),
      );
    });

    it("maps the duplicate's host+cwd, clears a decline, and deletes the duplicate", () => {
      app.db
        .update(projects)
        .set({ hostCwdsMeta: JSON.stringify({ auto: [macId], declined: [macId] }) })
        .where(eq(projects.id, survivorId))
        .run();
      expect(merge().ok).toBe(true);
      const s = app.db.select().from(projects).where(eq(projects.id, survivorId)).get()!;
      expect(parseHostCwds(s.hostCwds)[macId]).toBe(dupCwd);
      expect(parseHostCwdsMeta(s.hostCwdsMeta)).toEqual({ auto: [], declined: [], managed: [] });
      expect(app.db.select().from(projects).where(eq(projects.id, dupId)).get()).toBeUndefined();
    });

    it("accepts an identical existing mapping", () => {
      app.db
        .update(projects)
        .set({ hostCwds: serializeHostCwds({ [macId]: dupCwd }) })
        .where(eq(projects.id, survivorId))
        .run();
      expect(merge().ok).toBe(true);
    });

    it("re-points sessions (running too), browsers, devices, urls and targets", () => {
      const running = app.db
        .insert(sessions)
        .values({ projectId: dupId, command: "bash", status: "active" })
        .returning()
        .get();
      const done = app.db
        .insert(sessions)
        .values({ projectId: dupId, command: "bash", status: "exited" })
        .returning()
        .get();
      app.db.insert(sessionBrowsers).values({ sessionId: running.id, projectId: dupId }).run();
      app.db
        .insert(devices)
        .values({ kind: "emulator", avdName: "d", status: "active", projectId: dupId })
        .run();
      app.db.insert(projectUrls).values({ projectId: dupId, label: "l", url: "http://x" }).run();
      app.db
        .insert(projectPreviewTargets)
        .values({ id: "tgt", projectId: dupId, name: "n", destination: "3000" })
        .run();

      const res = merge();
      expect(res.ok && res.counts).toMatchObject({ sessions: 2, runningSessions: 1 });
      for (const id of [running.id, done.id]) {
        expect(app.db.select().from(sessions).where(eq(sessions.id, id)).get()?.projectId).toBe(
          survivorId,
        );
      }
      expect(app.db.select().from(sessionBrowsers).get()?.projectId).toBe(survivorId);
      expect(app.db.select().from(devices).get()?.projectId).toBe(survivorId);
      expect(app.db.select().from(projectUrls).get()?.projectId).toBe(survivorId);
      expect(app.db.select().from(projectPreviewTargets).get()?.projectId).toBe(survivorId);
    });

    it("pins host-less legacy sessions to the duplicate's host, re-keys live sessions and closes the duplicate's browser", () => {
      const legacy = app.db
        .insert(sessions)
        .values({ projectId: dupId, command: "bash", status: "active" })
        .returning()
        .get();
      const repoint = vi.spyOn(app.pty, "repointProject");
      const closeBrowser = vi.spyOn(app.browser, "closeForProject").mockResolvedValue();
      expect(merge().ok).toBe(true);
      expect(repoint).toHaveBeenCalledWith(dupId, survivorId);
      expect(closeBrowser).toHaveBeenCalledWith(dupId);
      expect(app.db.select().from(sessions).where(eq(sessions.id, legacy.id)).get()?.hostId).toBe(
        macId,
      );
    });

    it("previews: moves non-conflicting rows, drops a conflicting branch", () => {
      const add = (projectId: number, branch: string, slug: string) =>
        app.db.insert(previews).values({ slug, kind: "project", projectId, branch }).run();
      add(survivorId, "main", "s-main");
      add(dupId, "main", "d-main");
      add(dupId, "feat", "d-feat");
      expect(merge().ok).toBe(true);
      const all = app.db.select().from(previews).all();
      expect(all.map((p) => p.slug).sort()).toEqual(["d-feat", "s-main"]);
      expect(all.every((p) => p.projectId === survivorId)).toBe(true);
    });

    it("browser cookies: survivor wins a label clash, others move", () => {
      const add = (projectId: number, label: string, enc: string) =>
        app.db
          .insert(browserCookies)
          .values({ projectId, label, browser: "chrome", cookiesEnc: enc, cookieCount: 0 })
          .run();
      add(survivorId, "work", "keep");
      add(dupId, "work", "drop");
      add(dupId, "home", "move");
      expect(merge().ok).toBe(true);
      const all = app.db.select().from(browserCookies).all();
      expect(all.map((c) => c.cookiesEnc).sort()).toEqual(["keep", "move"]);
      expect(all.every((c) => c.projectId === survivorId)).toBe(true);
    });

    it("tooling: survivor wins, else the duplicate's moves", () => {
      app.db.insert(projectTooling).values({ projectId: dupId, skill: "dup" }).run();
      expect(merge().ok).toBe(true);
      expect(app.db.select().from(projectTooling).get()).toMatchObject({
        projectId: survivorId,
        skill: "dup",
      });
    });

    it("tooling: a survivor row is kept over the duplicate's", () => {
      app.db.insert(projectTooling).values({ projectId: survivorId, skill: "keep" }).run();
      app.db.insert(projectTooling).values({ projectId: dupId, skill: "dup" }).run();
      expect(merge().ok).toBe(true);
      const all = app.db.select().from(projectTooling).all();
      expect(all).toHaveLength(1);
      expect(all[0].skill).toBe("keep");
    });

    it("moves the duplicate's webhook row when the survivor has none", () => {
      app.db
        .insert(webhookRegistrations)
        .values({ projectId: dupId, owner: "acme", repo: "app", hookId: 1 })
        .run();
      expect(merge().ok).toBe(true);
      expect(app.db.select().from(webhookRegistrations).get()?.projectId).toBe(survivorId);
    });

    it("folds in the duplicate's other host mappings; the survivor's entries win", () => {
      app.db
        .update(projects)
        .set({ hostCwds: serializeHostCwds({ third: "/s/third" }) })
        .where(eq(projects.id, survivorId))
        .run();
      app.db
        .update(projects)
        .set({
          hostCwds: serializeHostCwds({ third: "/d/third", fourth: "/d/fourth", local: "/x" }),
        })
        .where(eq(projects.id, dupId))
        .run();
      expect(merge().ok).toBe(true);
      const s = app.db.select().from(projects).where(eq(projects.id, survivorId)).get()!;
      expect(parseHostCwds(s.hostCwds)).toEqual({
        third: "/s/third",
        fourth: "/d/fourth",
        [macId]: dupCwd,
      });
    });

    it("copies the conventional-titles resolution time with its value", () => {
      const at = new Date("2025-03-03T00:00:00Z");
      app.db
        .update(projects)
        .set({ conventionalCommitTitles: true, conventionalCommitTitlesResolvedAt: at })
        .where(eq(projects.id, dupId))
        .run();
      expect(merge().ok).toBe(true);
      const s = app.db.select().from(projects).where(eq(projects.id, survivorId)).get()!;
      expect(s.conventionalCommitTitles).toBe(true);
      expect(s.conventionalCommitTitlesResolvedAt?.getTime()).toBe(at.getTime());
    });

    it("drops the duplicate's webhook row and never unregisters the shared hook", () => {
      const unregister = vi.spyOn(githubWebhook, "unregisterHook");
      app.db
        .insert(webhookRegistrations)
        .values({ projectId: survivorId, owner: "acme", repo: "app", hookId: 1 })
        .run();
      app.db
        .insert(webhookRegistrations)
        .values({ projectId: dupId, owner: "acme", repo: "app", hookId: 1 })
        .run();
      expect(merge().ok).toBe(true);
      const regs = app.db.select().from(webhookRegistrations).all();
      expect(regs).toHaveLength(1);
      expect(regs[0].projectId).toBe(survivorId);
      expect(unregister).not.toHaveBeenCalled();
    });

    describe("tasks", () => {
      it("a live duplicate replaces the survivor's copy, which is archived with a NULL issue", () => {
        const stale = task(survivorId, { issueNumber: 7, status: "ready" });
        const live = task(dupId, { issueNumber: 7, status: "in_progress" });
        const events: number[] = [];
        vi.spyOn(taskEvents, "broadcastTaskEvent").mockImplementation((e) => {
          events.push(e.taskId);
        });
        const res = merge();
        expect(res.ok && res.movedTaskIds.sort()).toEqual([stale.id, live.id].sort());
        expect(events.sort()).toEqual([stale.id, live.id].sort());
        const moved = app.db.select().from(tasks).where(eq(tasks.id, live.id)).get()!;
        expect(moved).toMatchObject({ projectId: survivorId, issueNumber: 7 });
        const old = app.db.select().from(tasks).where(eq(tasks.id, stale.id)).get()!;
        expect(old.issueNumber).toBeNull();
        expect(old.archivedAt).not.toBeNull();
        expect(old.failureReason).toContain(`#${live.id}`);
        expect(old.projectId).toBe(survivorId);
      });

      it("a non-live duplicate clashing with the survivor is archived with a NULL issue", () => {
        const keep = task(survivorId, { issueNumber: 8, status: "in_progress" });
        const dup = task(dupId, { issueNumber: 8, status: "done" });
        expect(merge().ok).toBe(true);
        expect(app.db.select().from(tasks).where(eq(tasks.id, keep.id)).get()).toMatchObject({
          issueNumber: 8,
          archivedAt: null,
        });
        const d = app.db.select().from(tasks).where(eq(tasks.id, dup.id)).get()!;
        expect(d).toMatchObject({ projectId: survivorId, issueNumber: null });
        expect(d.archivedAt).not.toBeNull();
      });

      it("a superseded ready or backlog copy leaves the queue as failed; done rows stay as they are", () => {
        const keepA = task(survivorId, { issueNumber: 20, status: "in_progress" });
        const keepB = task(survivorId, { issueNumber: 21, status: "in_progress" });
        const keepC = task(survivorId, { issueNumber: 22, status: "in_progress" });
        const ready = task(dupId, { issueNumber: keepA.issueNumber, status: "ready" });
        const backlog = task(dupId, { issueNumber: keepB.issueNumber, status: "backlog" });
        const done = task(dupId, { issueNumber: keepC.issueNumber, status: "done" });
        expect(merge().ok).toBe(true);
        const row = (id: number) => app.db.select().from(tasks).where(eq(tasks.id, id)).get()!;
        for (const t of [ready, backlog]) {
          expect(row(t.id)).toMatchObject({ status: "failed", issueNumber: null });
          expect(row(t.id).archivedAt).not.toBeNull();
        }
        expect(row(done.id)).toMatchObject({ status: "done", issueNumber: null });
      });

      it("a replaced survivor copy that was ready ends up failed and archived", () => {
        const stale = task(survivorId, { issueNumber: 30, status: "ready" });
        task(dupId, { issueNumber: 30, status: "in_progress" });
        expect(merge().ok).toBe(true);
        const old = app.db.select().from(tasks).where(eq(tasks.id, stale.id)).get()!;
        expect(old.status).toBe("failed");
        expect(old.archivedAt).not.toBeNull();
      });

      it("moves tasks with no clash untouched, including local ones", () => {
        const a = task(dupId, { issueNumber: 9, status: "ready" });
        const b = task(dupId, { status: "backlog" });
        expect(merge().ok).toBe(true);
        for (const t of [a, b]) {
          expect(app.db.select().from(tasks).where(eq(tasks.id, t.id)).get()).toMatchObject({
            projectId: survivorId,
            archivedAt: null,
          });
        }
      });

      // #2292 — a superseded copy is marked as such, so `retryTask` refuses
      // it (it would otherwise resume the copy's branch and spawn a duplicate
      // worker for an issue another task owns).
      it("marks the superseded copy, so Retry can refuse it", () => {
        const keep = task(survivorId, { issueNumber: 40, status: "in_progress" });
        const dup = task(dupId, { issueNumber: 40, status: "failed" });
        expect(merge().ok).toBe(true);
        const row = app.db.select().from(tasks).where(eq(tasks.id, dup.id)).get()!;
        expect(row.supersededAt).not.toBeNull();
        expect(row.issueNumber).toBeNull();
        expect(row.archivedAt).not.toBeNull();
        // The survivor's copy is untouched — it owns the issue.
        expect(app.db.select().from(tasks).where(eq(tasks.id, keep.id)).get()).toMatchObject({
          issueNumber: 40,
          supersededAt: null,
        });
      });

      it("marks the replaced survivor copy too", () => {
        const stale = task(survivorId, { issueNumber: 41, status: "failed" });
        task(dupId, { issueNumber: 41, status: "in_progress" });
        expect(merge().ok).toBe(true);
        const row = app.db.select().from(tasks).where(eq(tasks.id, stale.id)).get()!;
        expect(row.supersededAt).not.toBeNull();
        expect(row.archivedAt).not.toBeNull();
      });

      it("does not mark a task that just moves", () => {
        const moved = task(dupId, { issueNumber: 42, status: "ready" });
        expect(merge().ok).toBe(true);
        expect(app.db.select().from(tasks).where(eq(tasks.id, moved.id)).get()).toMatchObject({
          projectId: survivorId,
          supersededAt: null,
          archivedAt: null,
        });
      });
    });

    describe("refusals", () => {
      it("same host", () => {
        const other = localProject(app, tmp, "app2", NEW);
        const res = mergeProjects(app, { survivorId, duplicateId: other.id });
        expect(res).toMatchObject({ ok: false, refusal: { code: "SAME_HOST" } });
        expect(app.db.select().from(projects).where(eq(projects.id, other.id)).get()).toBeDefined();
      });

      it("a different path already mapped for the host, changing nothing", () => {
        app.db
          .update(projects)
          .set({ hostCwds: serializeHostCwds({ [macId]: "/elsewhere" }) })
          .where(eq(projects.id, survivorId))
          .run();
        task(dupId, { status: "ready" });
        expect(merge()).toMatchObject({ ok: false, refusal: { code: "HOST_PATH_CONFLICT" } });
        expect(app.db.select().from(tasks).get()?.projectId).toBe(dupId);
      });

      it("a live task for the same issue in both projects", () => {
        task(survivorId, { issueNumber: 5, status: "claimed" });
        task(dupId, { issueNumber: 5, status: "in_progress" });
        expect(merge()).toMatchObject({ ok: false, refusal: { code: "LIVE_TASK_CONFLICT" } });
      });

      it("a full hostCwds map", () => {
        const full = Object.fromEntries(
          Array.from({ length: MAX_HOST_CWDS }, (_, i) => [`h${i}`, `/p${i}`]),
        );
        app.db
          .update(projects)
          .set({ hostCwds: serializeHostCwds(full) })
          .where(eq(projects.id, survivorId))
          .run();
        expect(merge()).toMatchObject({ ok: false, refusal: { code: "HOST_CWDS_LIMIT" } });
      });

      it("a docker-stack identity clash", () => {
        const stack = (projectId: number) =>
          app.db
            .insert(sessions)
            .values({
              projectId,
              command: "x",
              kind: "dock",
              status: "active",
              name: "docker-stack:web",
            })
            .run();
        stack(survivorId);
        stack(dupId);
        expect(merge()).toMatchObject({ ok: false, refusal: { code: "STACK_IDENTITY_CONFLICT" } });
      });

      it("itself, and a missing project", () => {
        expect(mergeProjects(app, { survivorId, duplicateId: survivorId })).toMatchObject({
          refusal: { code: "SAME_PROJECT" },
        });
        expect(mergeProjects(app, { survivorId, duplicateId: 99999 })).toMatchObject({
          refusal: { code: "NOT_FOUND" },
        });
      });
    });
  });
});

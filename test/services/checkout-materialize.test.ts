import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from "vitest";
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { eq, ne } from "drizzle-orm";
import { hosts, projects, sessions } from "../../src/db/schema.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { buildApp } = await import("../../src/app.js");
const { closeDb } = await import("../../src/db/client.js");
const sessionBackendModule = await import("../../src/services/session-backend.js");
const { createSessionRecord } = await import("../../src/services/session-lifecycle.js");
const { chooseHost, previewPlacement, resolveTargetHost } =
  await import("../../src/services/placement.js");
const hostGitModule = await import("../../src/services/host-git.js");
const remoteClientModule = await import("../../src/services/remote-host-client.js");
const setupRecipeModule = await import("../../src/services/setup-recipe.js");
const materialize = await import("../../src/services/checkout-materialize.js");
const preProvision = await import("../../src/services/pre-provision.js");
const projectOrigin = await import("../../src/services/project-origin.js");
const { detectCheckouts } = await import("../../src/services/host-checkout-detect.js");
const { parseHostCwds } = await import("../../src/services/placement.js");
const { parseHostCwdsMeta } = await import("../../src/services/host-cwds-meta.js");

// Lazy checkout materialization: a git project is cloned onto a host the first
// time something is placed there. Task Master's side is in task-claim.test.ts.

const tmpDb = path.join(os.tmpdir(), `checkout-materialize-${process.pid}.db`);
const ORIGIN = "https://github.com/acme/widget.git";
const REMOTE_CWD = "/srv/projects/widget";
// A platform the primary is NOT on, so a flag for it leaves the remote host the only candidate.
const OTHER = process.platform === "darwin" ? "linux" : "darwin";

const cap = {
  logicalCores: 8,
  loadAverage1m: 0.2,
  memory: { totalBytes: 1000, freeBytes: 500 },
  sessions: { tracked: 0, alive: 0 },
};
const idle = { logicalCores: 8, loadAverage1m: 0, loadPerCore: 0 };

function candidate(hostId: string, extra: object = {}) {
  return {
    hostId,
    isLocal: false,
    online: true,
    drained: false,
    capacity: { ...cap, platform: "linux" },
    projectCwd: null as string | null,
    ...extra,
  };
}
const context = { pinnedHostId: "home", unattended: true, localCapacity: null };

describe("chooseHost with checkouts to materialize", () => {
  it("treats a host without a path as a candidate marked needsCheckout", () => {
    const decision = chooseHost([candidate("b", { needsCheckout: true })], context);
    expect(decision).toMatchObject({ hostId: "b", fellBack: false, needsCheckout: true });
  });

  it("prefers a host that already has a checkout when the load ties", () => {
    const decision = chooseHost(
      [candidate("a", { needsCheckout: true }), candidate("z", { projectCwd: "/p" })],
      context,
    );
    expect(decision.hostId).toBe("z");
    expect(decision.needsCheckout).toBeUndefined();
  });

  it("still picks the less loaded host that needs a clone", () => {
    const light = { ...cap, loadAverage1m: 0.1, platform: "linux" };
    const decision = chooseHost(
      [
        candidate("a", { needsCheckout: true, capacity: light }),
        candidate("z", { projectCwd: "/p", capacity: { ...cap, loadAverage1m: 4 } }),
      ],
      context,
    );
    expect(decision).toMatchObject({ hostId: "a", needsCheckout: true });
  });

  it("excludes a host that reports no projects roots, with that reason", () => {
    const decision = chooseHost([candidate("b", { noProjectsRoots: true })], context);
    expect(decision.fellBack).toBe(true);
    expect(decision.excluded[0].reason).toContain("no projects roots");
    expect(idle.loadPerCore).toBe(0);
  });

  it("keeps the plain exclusion for a host the project cannot be cloned onto", () => {
    const decision = chooseHost([candidate("b")], context);
    expect(decision.excluded[0].reason).toBe("the project has no path on this host");
  });
});

describe("materializing a checkout", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  const dirs: string[] = [];

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
    materialize.clearMaterializeJobsForTests();
    projectOrigin.clearProjectOriginCacheForTests();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    app.db.delete(sessions).run();
    app.db.delete(projects).run();
    app.db.delete(hosts).where(ne(hosts.id, "local")).run();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  function repoDir(origin: string | null): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "materialize-"));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(
      path.join(dir, ".git", "config"),
      origin === null ? "[core]\n\tbare = false\n" : `[remote "origin"]\n\turl = ${origin}\n`,
    );
    return dir;
  }

  async function addHost(
    opts: { platform?: string; roots?: string[] | null; online?: boolean } = {},
  ) {
    const res = await app.inject({
      method: "POST",
      url: "/api/hosts",
      payload: { name: `h-${Math.random()}`, baseUrl: "http://127.0.0.1:1", token: "t" },
    });
    const hostId = res.json().id as string;
    if (opts.online === false) return hostId;
    app.hostHeartbeatTracker?.recordSuccess(hostId);
    app.hostCapacityTracker?.record(hostId, { ...cap, platform: opts.platform ?? OTHER });
    app.hostAgentTracker?.record(hostId, {
      agents: null,
      capabilities: null,
      mullionVersion: null,
      projectsRoots: opts.roots === undefined ? ["/srv/projects"] : opts.roots,
    });
    return hostId;
  }

  function addProject(
    cwd: string,
    extra: Partial<typeof projects.$inferInsert> = {},
  ): typeof projects.$inferSelect {
    const [project] = app.db
      .insert(projects)
      .values({
        name: `p-${Math.random()}`,
        cwd,
        hostId: "local",
        placement: "auto",
        placementConstraints: JSON.stringify({ platform: [OTHER], allowBurst: false }),
        ...extra,
      })
      .returning()
      .all();
    vi.spyOn(sessionBackendModule, "resolveBackend").mockReturnValue({
      createWorktree: vi.fn(async () => ({ created: true, path: "/wt", branch: "b" })),
      removeWorktree: vi.fn().mockResolvedValue(true),
      deleteBranch: vi.fn().mockResolvedValue({ deleted: true }),
      terminate: vi.fn().mockResolvedValue(undefined),
      stashSeed: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn().mockResolvedValue({}),
    } as unknown as ReturnType<typeof sessionBackendModule.resolveBackend>);
    return project;
  }

  const row = (id: number) => app.db.select().from(projects).where(eq(projects.id, id)).all()[0];

  const cloneOk = {
    ok: true,
    value: { ok: true, cwd: REMOTE_CWD, defaultBranch: "main", reused: false },
  };

  describe("placement", () => {
    it("marks a host with no path needsCheckout for a git project", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      const decision = previewPlacement(app, { project, unattended: true });
      expect(decision).toMatchObject({ hostId: host, needsCheckout: true, fellBack: false });
    });

    it("excludes a host reporting no projects roots", async () => {
      const host = await addHost({ roots: [] });
      const project = addProject(repoDir(ORIGIN));
      const decision = previewPlacement(app, { project, unattended: true });
      expect(decision.refusal).toBeDefined();
      expect(decision.excluded.find((e) => e.hostId === host)?.reason).toContain(
        "no projects roots",
      );
    });

    it("never offers a clone for a project that is not a git project", async () => {
      const host = await addHost();
      const project = addProject(repoDir(null));
      const decision = previewPlacement(app, { project, unattended: true });
      expect(decision.needsCheckout).toBeUndefined();
      expect(decision.excluded.find((e) => e.hostId === host)?.reason).toBe(
        "the project has no path on this host",
      );
    });

    it("never offers a clone onto a host the platform flag rules out", async () => {
      const host = await addHost({ platform: OTHER });
      const project = addProject(repoDir(ORIGIN), {
        placementConstraints: JSON.stringify({ platform: [process.platform], allowBurst: false }),
      });
      const decision = previewPlacement(app, { project, unattended: true });
      expect(decision.hostId).not.toBe(host);
      expect(decision.excluded.find((e) => e.hostId === host)?.reason).toContain("project allows");
    });

    it("treats an offline host to clone onto as transient for a targeted launch (a refusal waits)", async () => {
      const host = await addHost({ online: false });
      const project = addProject(repoDir(ORIGIN));
      const result = resolveTargetHost(app, {
        project,
        target: { hostId: host },
        unattended: true,
      });
      expect(result).toMatchObject({ ok: false, transient: true });
    });

    it("does not wait for an offline host when the project is not a git project", async () => {
      const host = await addHost({ online: false });
      const project = addProject(repoDir(null));
      const result = resolveTargetHost(app, {
        project,
        target: { hostId: host },
        unattended: true,
      });
      expect(result).toMatchObject({ ok: false, transient: false });
    });
  });

  describe("the job", () => {
    it("clones once for concurrent requests, then records the managed checkout", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      let release: (v: unknown) => void = () => {};
      const clone = vi
        .spyOn(hostGitModule, "cloneHostCheckout")
        .mockReturnValue(new Promise((r) => (release = r)) as never);

      const first = materialize.startMaterialize(app, project.id, host);
      const second = materialize.startMaterialize(app, project.id, host);
      expect(second).toBe(first);
      expect(first.state).toBe("cloning");
      await vi.waitFor(() => expect(clone).toHaveBeenCalledTimes(1));
      expect(clone.mock.calls[0][2]).toEqual({ url: ORIGIN, name: "widget" });

      release(cloneOk);
      await vi.waitFor(() => expect(first.state).toBe("done"));
      expect(first.cwd).toBe(REMOTE_CWD);
      const saved = row(project.id);
      expect(parseHostCwds(saved.hostCwds)[host]).toBe(REMOTE_CWD);
      expect(parseHostCwdsMeta(saved.hostCwdsMeta).managed).toEqual([host]);
      // A host that now has the path is done at once, nothing is cloned again.
      expect(materialize.startMaterialize(app, project.id, host).state).toBe("done");
      expect(clone).toHaveBeenCalledTimes(1);
    });

    it("starts the project's setup recipe in the fresh clone, and not after a failed one", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      const setup = vi
        .spyOn(setupRecipeModule, "startSetupAfterClone")
        .mockImplementation(() => {});
      vi.spyOn(hostGitModule, "cloneHostCheckout").mockResolvedValue(cloneOk as never);
      const job = materialize.startMaterialize(app, project.id, host);
      await vi.waitFor(() => expect(job.state).toBe("done"));
      expect(setup).toHaveBeenCalledTimes(1);
      expect(setup.mock.calls[0][1].id).toBe(project.id);
      expect(setup.mock.calls[0].slice(2)).toEqual([host, REMOTE_CWD]);
    });

    it("keeps the reason and detail of a failed clone, and writes nothing", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      vi.spyOn(hostGitModule, "cloneHostCheckout").mockResolvedValue({
        ok: true,
        value: { ok: false, reason: "auth", detail: "repository not found" },
      });
      const job = materialize.startMaterialize(app, project.id, host);
      await vi.waitFor(() => expect(job.state).toBe("failed"));
      expect(job).toMatchObject({ reason: "auth", detail: "repository not found" });
      expect(row(project.id).hostCwds).toBeNull();
      expect(materialize.takeFailedMaterialize(project.id, host)?.detail).toBe(
        "repository not found",
      );
      expect(materialize.getMaterializeJob(project.id, host)).toBeUndefined();
    });

    it("fails when the host cannot be asked, an ssh origin is rewritten to https", async () => {
      const host = await addHost();
      const project = addProject(repoDir("git@github.com:acme/widget.git"));
      const clone = vi
        .spyOn(hostGitModule, "cloneHostCheckout")
        .mockResolvedValue({ ok: false, reason: "unreachable" } as never);
      const job = materialize.startMaterialize(app, project.id, host);
      await vi.waitFor(() => expect(job.state).toBe("failed"));
      expect(job.detail).toContain("unreachable");
      expect(clone.mock.calls[0][2]).toEqual({
        url: "https://github.com/acme/widget.git",
        name: "widget",
      });
    });

    it("fails a project with no origin and an unknown host without cloning", async () => {
      const project = addProject(repoDir(null));
      expect(materialize.startMaterialize(app, project.id, "nope").state).toBe("failed");
      const host = await addHost();
      const clone = vi.spyOn(hostGitModule, "cloneHostCheckout");
      const job = materialize.startMaterialize(app, project.id, host);
      await vi.waitFor(() => expect(job.state).toBe("failed"));
      expect(job.detail).toContain("no git origin");
      expect(clone).not.toHaveBeenCalled();
      expect(materialize.startMaterialize(app, 99999, host).detail).toContain("no longer exists");
    });
  });

  describe("POST /api/sessions", () => {
    it("answers 202 with no session row, then creates once the checkout exists", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      vi.spyOn(hostGitModule, "cloneHostCheckout").mockResolvedValue(cloneOk as never);
      const before = app.db.select().from(sessions).all().length;

      const res = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.id, command: "bash", unattended: true },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual({ preparingCheckout: { projectId: project.id, hostId: host } });
      expect(app.db.select().from(sessions).all()).toHaveLength(before);

      const status = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/host-checkouts/${host}/materialize`,
      });
      expect(["cloning", "done"]).toContain(status.json().state);
      await vi.waitFor(() =>
        expect(materialize.getMaterializeJob(project.id, host)?.state).toBe("done"),
      );
      const done = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/host-checkouts/${host}/materialize`,
      });
      expect(done.json()).toMatchObject({ state: "done", cwd: REMOTE_CWD });

      const again = await app.inject({
        method: "POST",
        url: "/api/sessions",
        payload: { projectId: project.id, command: "bash" },
      });
      expect(again.statusCode).toBe(201);
      expect(again.json().hostId).toBe(host);
    });

    it("other callers get a clear refusal instead of a 202", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      vi.spyOn(hostGitModule, "cloneHostCheckout").mockReturnValue(new Promise(() => {}));
      const result = await createSessionRecord(app, { projectId: project.id, command: "bash" });
      expect(result).toMatchObject({
        ok: false,
        reason: "preparing-checkout",
        hostId: host,
        detail: `preparing checkout on ${host}`,
      });
    });
  });

  describe("the materialize routes", () => {
    it("reports idle, own host and 404/400 cases, and starts a job on POST", async () => {
      const host = await addHost();
      const project = addProject(repoDir(ORIGIN));
      const base = `/api/projects/${project.id}/host-checkouts`;
      expect(
        (await app.inject({ method: "GET", url: `${base}/${host}/materialize` })).json(),
      ).toEqual({
        state: "idle",
      });
      expect(
        (await app.inject({ method: "GET", url: `${base}/local/materialize` })).json(),
      ).toMatchObject({
        state: "done",
        cwd: project.cwd,
      });
      expect(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/9999/host-checkouts/${host}/materialize`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: "POST", url: `${base}/nope/materialize` })).statusCode,
      ).toBe(400);
      vi.spyOn(hostGitModule, "cloneHostCheckout").mockResolvedValue(cloneOk as never);
      const started = await app.inject({ method: "POST", url: `${base}/${host}/materialize` });
      expect(started.statusCode).toBe(202);
      await vi.waitFor(() =>
        expect(materialize.getMaterializeJob(project.id, host)?.state).toBe("done"),
      );
    });
  });

  describe("pre-provision", () => {
    it("parses and serializes the stored value", () => {
      const { parsePreProvision, serializePreProvision } = preProvision;
      expect(parsePreProvision(null)).toBe("none");
      expect(parsePreProvision("garbage")).toBe("none");
      expect(parsePreProvision('"all"')).toBe("all");
      expect(parsePreProvision('["a","a","b",1]')).toEqual(["a", "b"]);
      expect(parsePreProvision("[]")).toBe("none");
      expect(serializePreProvision("none")).toBeNull();
      expect(serializePreProvision([])).toBeNull();
      expect(serializePreProvision("all")).toBe('"all"');
      expect(serializePreProvision(["a"])).toBe('["a"]');
    });

    it("selects eligible hosts only, per mode", async () => {
      const a = await addHost();
      const b = await addHost();
      const noRoots = await addHost({ roots: [] });
      const wrongPlatform = await addHost({
        platform: "win32",
      });
      const project = addProject(repoDir(ORIGIN), {
        preProvision: JSON.stringify("all"),
        hostCwds: JSON.stringify({ [b]: "/already" }),
      });
      projectOrigin.clearProjectOriginCacheForTests();
      const targets = preProvision.preProvisionTargets(app, row(project.id));
      expect(targets).toContain(a);
      expect(targets).not.toContain(b); // already has a path
      expect(targets).not.toContain(noRoots);
      expect(targets).not.toContain(wrongPlatform);
      expect(targets).not.toContain("local"); // the project's own host

      app.db
        .update(projects)
        .set({ preProvision: JSON.stringify([a, noRoots]) })
        .where(eq(projects.id, project.id))
        .run();
      expect(preProvision.preProvisionTargets(app, row(project.id))).toEqual([a]);
      expect(preProvision.preProvisionTargets(app, row(project.id), "other-host")).toEqual([]);
      app.db.update(projects).set({ preProvision: null }).where(eq(projects.id, project.id)).run();
      expect(preProvision.preProvisionTargets(app, row(project.id))).toEqual([]);
    });

    it("the sweep starts a job for each selected host, and none for a project with it off", async () => {
      const a = await addHost();
      const project = addProject(repoDir(ORIGIN), { preProvision: JSON.stringify([a]) });
      addProject(repoDir(ORIGIN));
      const clone = vi
        .spyOn(hostGitModule, "cloneHostCheckout")
        .mockResolvedValue(cloneOk as never);
      expect(await preProvision.runPreProvisionSweep(app)).toBe(1);
      await vi.waitFor(() =>
        expect(materialize.getMaterializeJob(project.id, a)?.state).toBe("done"),
      );
      expect(clone).toHaveBeenCalledTimes(1);
      // The next sweep finds the path and starts nothing.
      expect(await preProvision.runPreProvisionSweep(app)).toBe(0);
    });

    it("is read and written through the project API", async () => {
      const dir = repoDir(ORIGIN);
      const created = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: `pp-${Math.random()}`, cwd: dir, preProvision: "all" },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json().preProvision).toBe("all");
      const id = created.json().id as number;
      const patched = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { preProvision: ["h1"] },
      });
      expect(patched.json().preProvision).toEqual(["h1"]);
      const cleared = await app.inject({
        method: "PATCH",
        url: `/api/projects/${id}`,
        payload: { preProvision: null },
      });
      expect(cleared.json().preProvision).toBe("none");
      expect(row(id).preProvision).toBeNull();
    });
  });

  describe("discovery", () => {
    it("never suggests a path some project already owns, a managed clone included", async () => {
      const host = await addHost();
      const dir = repoDir(ORIGIN);
      addProject(dir, {
        name: "owner",
        hostCwds: JSON.stringify({ [host]: REMOTE_CWD }),
        hostCwdsMeta: JSON.stringify({ auto: [], declined: [], managed: [host] }),
      });
      const second = addProject(repoDir(ORIGIN), { name: "second" });
      vi.spyOn(remoteClientModule, "getRemoteHostClient").mockReturnValue({
        discover: async () => [
          { name: "widget", cwd: REMOTE_CWD, isGitRepo: true, origin: ORIGIN },
        ],
      } as never);
      expect(await detectCheckouts(app, second)).toEqual([]);

      vi.spyOn(remoteClientModule, "getRemoteHostClient").mockReturnValue({
        discover: async () => [
          { name: "widget", cwd: "/srv/other/widget", isGitRepo: true, origin: ORIGIN },
        ],
      } as never);
      const found = await detectCheckouts(app, second);
      expect(found[0].candidates[0].cwd).toBe("/srv/other/widget");
    });
  });
});

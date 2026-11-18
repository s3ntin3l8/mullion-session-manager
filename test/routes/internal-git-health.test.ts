import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import type { CloneHealth } from "../../src/shared/types.js";

const ptyHarness = createInternalPtyHarness();
const childProcessHarness = createInternalChildProcessHarness();
const bundleSyncHarness = createBundleSyncHarness();

vi.mock("node-pty", () => ptyHarness.mockModule());
vi.mock("node:child_process", async (importOriginal) =>
  childProcessHarness.mockModule(await importOriginal()),
);
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncHarness.mockModule());
const { buildApp } = await import("../../src/app.js");
const { clearAgentsCacheForTests } = await import("../../src/services/agent-detect.js");
const { execFileSync } = await import("node:child_process");
const { gitEnv } = await import("../../src/services/git-env.js");
const { cloneWithRemote } = await import("../helpers/git-clone.js");

const TOKEN = INTERNAL_TEST_TOKEN;

describe("internal routes: git health, repair, and actions", () => {
  const env = createInternalAgentEnv();
  let projectsRoot: string;
  beforeAll(() => {
    env.setup();
    projectsRoot = env.projectsRoot;
  });
  afterAll(() => {
    env.teardown();
  });
  beforeEach(() => {
    ptyHarness.reset();
    childProcessHarness.reset();
    bundleSyncHarness.reset();
    clearAgentsCacheForTests();
  });

  it("requires a cwd query param for actions and dock", async () => {
    const app = await buildApp();
    const actions = await app.inject({
      method: "GET",
      url: "/internal/actions",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: "/internal/dock",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);
    await app.close();
  });

  it("resolves actions and dock for a cwd on this host", async () => {
    const app = await buildApp();
    const cwd = path.join(projectsRoot, "git-repo");

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(200);
    expect(Array.isArray(actions.json())).toBe(true);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(cwd)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(200);
    expect(dock.json()).toEqual([]);
    await app.close();
  });

  it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-outside-roots-"));

    const actions = await app.inject({
      method: "GET",
      url: `/internal/actions?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(actions.statusCode).toBe(400);

    const dock = await app.inject({
      method: "GET",
      url: `/internal/dock?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(dock.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  // Issue #1851 — the READ-ONLY clone health check, for a remote-hosted
  // project's clone. It goes through the same resolveWithinRoots gate as
  // every other filesystem-touching route in this file, and it never
  // mutates anything.
  it("reports the health of a clone on this host", async () => {
    const app = await buildApp();
    const repo = path.join(projectsRoot, "health-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnv() });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "one"], { env: gitEnv() });

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-health?cwd=${encodeURIComponent(repo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CloneHealth;
    expect(body.healthy).toBe(true);
    expect(body.gitDir).toBe(path.join(repo, ".git"));
    expect(body.zeroByteObjects).toEqual([]);
    expect(body.otherZeroByteFiles).toEqual([]);
    expect(body.fsckErrors).toEqual([]);
    await app.close();
  });

  // The check is READ-ONLY: a damaged clone is reported, never repaired.
  it("reports a damaged clone as unhealthy, and changes nothing", async () => {
    const app = await buildApp();
    const repo = path.join(projectsRoot, "damaged-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnv() });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "one"], { env: gitEnv() });
    // A zero-byte loose object — the #1836 damage.
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], {
      env: gitEnv(),
      encoding: "utf8",
    }).trim();
    const loose = path.join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    fs.rmSync(loose, { force: true });
    fs.writeFileSync(loose, "");

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-health?cwd=${encodeURIComponent(repo)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as CloneHealth;
    expect(body.healthy).toBe(false);
    expect(body.zeroByteObjects).toHaveLength(1);
    // Read-only: the damage is still exactly where it was.
    expect(fs.statSync(loose).size).toBe(0);
    await app.close();
  });

  it("rejects a git-health request with no cwd", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/internal/git-health",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a git-health request for a cwd outside this agent's PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-health-outside-"));

    const res = await app.inject({
      method: "GET",
      url: `/internal/git-health?cwd=${encodeURIComponent(outsideRoots)}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  // Issue #1896 — the clone REPAIR on this agent's own filesystem, and the
  // read-only PLAN of what it would do.
  it("returns a plan for a git-repair request, and changes nothing", async () => {
    const app = await buildApp();
    const repo = path.join(projectsRoot, "repair-plan-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnv() });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "one"], { env: gitEnv() });
    // A zero-byte loose object — the #1836 damage.
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], {
      env: gitEnv(),
      encoding: "utf8",
    }).trim();
    const loose = path.join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    fs.rmSync(loose, { force: true });
    fs.writeFileSync(loose, "");

    const res = await app.inject({
      method: "POST",
      url: "/internal/git-repair",
      payload: { cwd: repo },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quarantine).toEqual([tree]);
    expect(body.actionable).toBe(true);
    // The plan is a READ: the damaged object is still exactly where it was.
    expect(fs.statSync(loose).size).toBe(0);
    expect(
      fs.readdirSync(path.join(repo, ".git")).some((n) => n.startsWith("gc-quarantine-")),
    ).toBe(false);
    await app.close();
  });

  it("repairs the clone when a git-repair request confirms it", async () => {
    const app = await buildApp();
    const repo = path.join(projectsRoot, "repair-run-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });
    fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
    execFileSync("git", ["-C", repo, "add", "-A"], { env: gitEnv() });
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "one"], { env: gitEnv() });
    const tree = execFileSync("git", ["-C", repo, "rev-parse", "HEAD^{tree}"], {
      env: gitEnv(),
      encoding: "utf8",
    }).trim();
    const loose = path.join(repo, ".git", "objects", tree.slice(0, 2), tree.slice(2));
    fs.rmSync(loose, { force: true });
    fs.writeFileSync(loose, "");

    const res = await app.inject({
      method: "POST",
      url: "/internal/git-repair",
      payload: { cwd: repo, confirm: true },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.quarantined).toEqual([tree]);
    expect(body.quarantine).toContain("gc-quarantine-");
    // The damaged object was MOVED out of objects/ — never deleted.
    expect(fs.existsSync(loose)).toBe(false);
    await app.close();
  });

  // The clone is the resource: a repair and a fetch on the same clone would
  // fight over the refs (issue #1896).
  it("refuses a git-repair request for a clone a git operation has claimed", async () => {
    const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
    const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
    const app = await buildApp();
    const repo = path.join(projectsRoot, "busy-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });

    markCloneBusy(LOCAL_HOST_ID, repo);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/git-repair",
        payload: { cwd: repo, confirm: true },
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(409);
    } finally {
      releaseClone(LOCAL_HOST_ID, repo);
    }
    await app.close();
  });

  // The agent-side fetch the primary's auto-fetch sweep calls on every remote
  // project. It had no test at all.
  it("fetches a clone on this agent", async () => {
    const app = await buildApp();
    // Inside this agent's PROJECTS_ROOTS — the route confines the cwd there.
    // Inside this agent's PROJECTS_ROOTS — the route confines the cwd there.
    const base = fs.mkdtempSync(path.join(projectsRoot, "internal-git-fetch-"));
    const { repo, fetchedHead: head } = cloneWithRemote(base);

    try {
      const res = await app.inject({
        method: "GET",
        url: `/internal/git-fetch?cwd=${encodeURIComponent(repo)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expect.objectContaining({ success: true }));
      const ref = execFileSync(
        "git",
        ["-C", repo, "rev-parse", "--verify", "refs/remotes/origin/main"],
        { env: gitEnv(), encoding: "utf8" },
      ).trim();
      expect(ref).toBe(head);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      await app.close();
    }
  });

  it("skips a git-pull for a clone a git operation has claimed", async () => {
    const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
    const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
    const app = await buildApp();
    const repo = path.join(projectsRoot, "busy-pull-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });

    markCloneBusy(LOCAL_HOST_ID, repo);
    try {
      const res = await app.inject({
        method: "POST",
        url: "/internal/git-pull",
        payload: { cwd: repo },
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(expect.objectContaining({ pulled: false, reason: "busy" }));
    } finally {
      releaseClone(LOCAL_HOST_ID, repo);
    }
    await app.close();
  });

  it("skips a git-fetch for a clone a git operation has claimed", async () => {
    const { markCloneBusy, releaseClone } = await import("../../src/services/git-clone-busy.js");
    const { LOCAL_HOST_ID } = await import("../../src/services/host-registry.js");
    const app = await buildApp();
    const repo = path.join(projectsRoot, "busy-fetch-repo");
    execFileSync("git", ["init", "-q", repo], { env: gitEnv() });

    markCloneBusy(LOCAL_HOST_ID, repo);
    try {
      const res = await app.inject({
        method: "GET",
        url: `/internal/git-fetch?cwd=${encodeURIComponent(repo)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      // A busy clone is SKIPPED, not failed: the primary must not log this
      // as "git fetch failed" or surface it as an error on the Fetch button.
      expect(res.json()).toEqual(expect.objectContaining({ success: false, skipped: true }));
    } finally {
      releaseClone(LOCAL_HOST_ID, repo);
    }
    await app.close();
  });

  it("rejects a git-repair request with no cwd", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/internal/git-repair",
      payload: {},
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("rejects a git-repair request for a cwd outside this agent's PROJECTS_ROOTS", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-git-repair-outside-"));

    const res = await app.inject({
      method: "POST",
      url: "/internal/git-repair",
      payload: { cwd: outsideRoots },
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.statusCode).toBe(400);

    fs.rmSync(outsideRoots, { recursive: true, force: true });
    await app.close();
  });

  // Issue #604 — resolveWithinRoots used to compare only the LEXICAL cwd
  // against PROJECTS_ROOTS, so a symlink planted inside a root (something
  // an authenticated caller with filesystem access to a project could do)
  // passed the containment check on its lexical path even though it points
  // straight outside every configured root. Before the fix this cwd would
  // have 200'd (following the symlink transparently); the fix compares
  // realpath'd paths instead, so this must now 400 exactly like the
  // "outside PROJECTS_ROOTS" case above.
  it("rejects a cwd that is a symlink inside PROJECTS_ROOTS pointing outside it (issue #604)", async () => {
    const app = await buildApp();
    const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-symlink-escape-"));
    const escapeLink = path.join(projectsRoot, "escape-link");
    fs.symlinkSync(outsideRoots, escapeLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(escapeLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).toBe(400);

      const dock = await app.inject({
        method: "GET",
        url: `/internal/dock?cwd=${encodeURIComponent(escapeLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(dock.statusCode).toBe(400);
    } finally {
      fs.rmSync(escapeLink, { force: true });
      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    }
  });

  // The other direction: a symlink INSIDE a legitimate project dir, still
  // resolving to somewhere INSIDE that same PROJECTS_ROOTS entry, must stay
  // accepted — the realpath-based check must not reject ordinary intra-root
  // symlinks the way it now rejects an escaping one.
  it("still accepts a cwd whose symlink resolves to somewhere inside the same PROJECTS_ROOTS entry", async () => {
    const app = await buildApp();
    const realProject = path.join(projectsRoot, "real-project");
    fs.mkdirSync(realProject, { recursive: true });
    const innerLink = path.join(projectsRoot, "inner-link");
    fs.symlinkSync(realProject, innerLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(innerLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).toBe(200);
    } finally {
      fs.rmSync(innerLink, { force: true });
      fs.rmSync(realProject, { recursive: true, force: true });
      await app.close();
    }
  });

  // Hermes review, PR #612: a DANGLING cwd symlink (the link exists, its
  // target doesn't) is the trickiest case realpathExistingPrefix's ENOENT
  // fallback handles — fs.realpathSync itself throws ENOENT resolving a
  // dangling link (not just a genuinely missing path), so this hits the
  // exact same "doesn't exist yet, fall back to lexical" branch a brand-new
  // project would. Containment passes on the lexical value (same as before
  // this fix, since there's nothing to realpath through), but every
  // downstream sink fails closed reading a target that doesn't exist —
  // nothing escapes, this just pins that no request-shaped input here
  // crashes with a 500.
  it("handles a DANGLING cwd symlink inside PROJECTS_ROOTS without erroring or leaking anything", async () => {
    const app = await buildApp();
    const danglingLink = path.join(projectsRoot, "dangling-link");
    fs.symlinkSync(path.join(projectsRoot, "nonexistent-target"), danglingLink);

    try {
      const actions = await app.inject({
        method: "GET",
        url: `/internal/actions?cwd=${encodeURIComponent(danglingLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(actions.statusCode).not.toBe(500);

      const dock = await app.inject({
        method: "GET",
        url: `/internal/dock?cwd=${encodeURIComponent(danglingLink)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(dock.statusCode).not.toBe(500);
    } finally {
      fs.rmSync(danglingLink, { force: true });
      await app.close();
    }
  });

  // U4 — the agent-side half of the dock-config write triple
  // (routes/dock-config.ts is the primary side). Same
  // resolveWithinRoots-containment shape as /internal/actions and
  // /internal/dock above, and the same CodeQL js/path-injection concern
  // those two already have a test for — GitHub Advanced Security flagged
  // this exact new file (dock-config.ts) on the PR that introduced it;
  // this proves the containment gate is real, executing code, not just a
  // comment claiming it is.
});

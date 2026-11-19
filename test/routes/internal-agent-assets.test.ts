import { describe, it, expect, beforeEach, beforeAll, afterAll, afterEach, vi } from "vitest";
import {
  createInternalPtyHarness,
  createInternalChildProcessHarness,
  createBundleSyncHarness,
  createInternalAgentEnv,
  INTERNAL_TEST_TOKEN,
  PNG_BYTES,
} from "../helpers/internal-routes.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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

const TOKEN = INTERNAL_TEST_TOKEN;
const { uninstallBundleContentMock, runBundleSyncExclusiveMock } = bundleSyncHarness;

describe("internal routes: dock-config, agent-rules, skills, bundle-sync, and uploads", () => {
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

  describe("/internal/dock-config (U4, CodeQL: uncontrolled data in path expression)", () => {
    it("requires a cwd query param for both GET and PUT", async () => {
      const app = await buildApp();
      const get = await app.inject({
        method: "GET",
        url: "/internal/dock-config",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(400);

      const put = await app.inject({
        method: "PUT",
        url: "/internal/dock-config",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [] },
      });
      expect(put.statusCode).toBe(400);
      await app.close();
    });

    it("resolves and writes dock.json for a cwd on this host", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const get = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toEqual({
        controls: [],
        invalid: false,
        reason: null,
        isSymlink: false,
      });

      const put = await app.inject({
        method: "PUT",
        url: `/internal/dock-config?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(put.statusCode).toBe(200);
      expect(JSON.parse(fs.readFileSync(path.join(cwd, ".crs", "dock.json"), "utf8"))).toEqual({
        controls: [{ id: "x", title: "X", command: "echo x" }],
      });
      fs.rmSync(path.join(cwd, ".crs"), { recursive: true, force: true });
      await app.close();
    });

    // The concrete proof the coordinator asked for: a cwd outside this
    // agent's own PROJECTS_ROOTS must be rejected before it ever reaches
    // dock-config.ts's readDockConfig/writeDockConfig — for BOTH verbs,
    // and PUT must not have written anything to that outside directory.
    it("rejects a cwd outside this agent's own PROJECTS_ROOTS for both GET and PUT, and never writes", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-dock-config-outside-"));

      const get = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(get.statusCode).toBe(400);

      const put = await app.inject({
        method: "PUT",
        url: `/internal/dock-config?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { controls: [{ id: "x", title: "X", command: "echo x" }] },
      });
      expect(put.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, ".crs"))).toBe(false);

      // A "../" traversal attempt riding on an otherwise-in-roots cwd must
      // resolve (path.resolve collapses ".." segments) to a path that's
      // STILL checked against PROJECTS_ROOTS, not escape the check via the
      // literal ".." substring.
      const traversal = `${path.join(projectsRoot, "git-repo")}/../../../../../../etc`;
      const traversalGet = await app.inject({
        method: "GET",
        url: `/internal/dock-config?cwd=${encodeURIComponent(traversal)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(traversalGet.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });
  });

  // Issue #431 — the agent-side half of the agent-rules triple
  // (routes/agent-rules.ts is the primary side). Global-scope targets
  // resolve off os.homedir(), redirected here the same way
  // test/services/agent-rules.test.ts does, so this never touches the
  // real test-runner's own ~/.claude etc.

  describe("/internal/agent-rules (issue #431)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/agent-rules",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS (CodeQL: this route WRITES, unlike the read-only ones above)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-agent-rules-outside-"));

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(400);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "malicious" },
      });
      expect(write.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, "CLAUDE.md"))).toBe(false);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists, writes, and deletes a target for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const list = await app.inject({
        method: "GET",
        url: `/internal/agent-rules?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(list.statusCode).toBe(200);
      expect(Array.isArray(list.json())).toBe(true);

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "written via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("written via internal route");
      expect(fs.readFileSync(path.join(cwd, "CLAUDE.md"), "utf8")).toBe(
        "written via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(cwd, "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — this route used to reject a
    // global-scope target id here, which for a remote-hosted project's
    // global CLAUDE.md/AGENTS.md forced the primary through a standalone,
    // primary-host-only route instead — silently writing to the *primary's*
    // filesystem, not this (remote) host's. `cwd` is still confined to
    // PROJECTS_ROOTS, but it's unused for a global-scope target (which
    // resolves off this host's own redirected HOME instead).
    it("writes and deletes a global-scope target id on the project-scoped write/delete routes, resolved on this host's own HOME", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");

      const write = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { content: "global content via internal route" },
      });
      expect(write.statusCode).toBe(200);
      expect(write.json().content).toBe("global content via internal route");
      expect(fs.readFileSync(path.join(fakeHome, ".claude", "CLAUDE.md"), "utf8")).toBe(
        "global content via internal route",
      );

      const del = await app.inject({
        method: "DELETE",
        url: `/internal/agent-rules/claude-code:global?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(del.statusCode).toBe(204);
      expect(fs.existsSync(path.join(fakeHome, ".claude", "CLAUDE.md"))).toBe(false);

      await app.close();
    });

    it("400s on a malformed body (missing content) via the new schema", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "git-repo");
      const res = await app.inject({
        method: "PUT",
        url: `/internal/agent-rules/claude-code:project?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    // Issue #431, Hermes review on PR #458 — the names-only counterpart the
    // sidebar's per-project indicator uses instead of the full listing.
    describe("/internal/agent-rules/exists", () => {
      it("requires a cwd query param", async () => {
        const app = await buildApp();
        const res = await app.inject({
          method: "GET",
          url: "/internal/agent-rules/exists",
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        await app.close();
      });

      it("rejects a cwd outside PROJECTS_ROOTS", async () => {
        const app = await buildApp();
        const outsideRoots = fs.mkdtempSync(
          path.join(os.tmpdir(), "internal-agent-rules-exists-outside-"),
        );
        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(outsideRoots)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(400);
        fs.rmSync(outsideRoots, { recursive: true, force: true });
        await app.close();
      });

      it("returns only existing project-scope filenames, never content", async () => {
        const app = await buildApp();
        const cwd = fs.mkdtempSync(path.join(projectsRoot, "exists-test-"));
        fs.writeFileSync(path.join(cwd, "AGENTS.md"), "should not appear in the response");

        const res = await app.inject({
          method: "GET",
          url: `/internal/agent-rules/exists?cwd=${encodeURIComponent(cwd)}`,
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual(["AGENTS.md"]);
        expect(res.payload).not.toContain("should not appear");

        fs.rmSync(cwd, { recursive: true, force: true });
        await app.close();
      });
    });
  });

  // Issue #432 — the agent-side half of the skills-discovery triple
  // (routes/skills.ts is the primary side). Same fake-HOME redirection
  // reasoning as /internal/agent-rules above.

  describe("/internal/skills (issue #432)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-home-"));
      process.env.HOME = fakeHome;
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    function writeSkill(dir: string, name: string, description: string) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: ${description}\n---\n`,
      );
    }

    it("requires a cwd query param", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/skills",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a cwd outside PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-skills-outside-"));

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(outsideRoots)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("lists project- and global-scope skills for a cwd within PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const cwd = path.join(projectsRoot, "skills-repo");
      writeSkill(path.join(cwd, ".claude", "skills", "proj-skill"), "proj-skill", "in the repo");
      writeSkill(
        path.join(fakeHome, ".claude", "skills", "home-skill"),
        "home-skill",
        "in the home dir",
      );

      const res = await app.inject({
        method: "GET",
        url: `/internal/skills?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      const byName = Object.fromEntries(
        res.json().map((s: { name: string; scope: string }) => [s.name, s]),
      );
      expect(byName["proj-skill"].scope).toBe("project");
      expect(byName["home-skill"].scope).toBe("global");

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });
  });

  describe("/internal/bundle-sync/status and /remove (issue #1089)", () => {
    let fakeHome: string;
    const originalHome = process.env.HOME;

    beforeEach(() => {
      fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "internal-bundle-sync-home-"));
      process.env.HOME = fakeHome;
      uninstallBundleContentMock.mockClear();
      uninstallBundleContentMock.mockResolvedValue({ removed: 3, legacySwept: 1 });
      runBundleSyncExclusiveMock.mockClear();
      runBundleSyncExclusiveMock.mockResolvedValue({ changed: true });
    });

    afterEach(() => {
      fs.rmSync(fakeHome, { recursive: true, force: true });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    });

    it("GET /internal/bundle-sync/status reports disabled: false when no state file exists yet", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: "/internal/bundle-sync/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ disabled: false });
      await app.close();
    });

    it("POST /internal/bundle-sync/remove with disabled: true writes the flag and runs removal", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/bundle-sync/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { disabled: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: 3, legacySwept: 1, disabled: true });
      expect(uninstallBundleContentMock).toHaveBeenCalledTimes(1);

      const statusRes = await app.inject({
        method: "GET",
        url: "/internal/bundle-sync/status",
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(statusRes.json()).toEqual({ disabled: true });

      await app.close();
    });

    it("POST /internal/bundle-sync/remove with disabled: false clears the flag and re-syncs, without running removal (issue #1128)", async () => {
      const app = await buildApp();
      await app.inject({
        method: "POST",
        url: "/internal/bundle-sync/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { disabled: true },
      });
      uninstallBundleContentMock.mockClear();
      runBundleSyncExclusiveMock.mockClear();

      const res = await app.inject({
        method: "POST",
        url: "/internal/bundle-sync/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: { disabled: false },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ removed: 0, legacySwept: 0, disabled: false });
      expect(uninstallBundleContentMock).not.toHaveBeenCalled();
      expect(runBundleSyncExclusiveMock).toHaveBeenCalledExactlyOnceWith(true);

      await app.close();
    });

    it("POST /internal/bundle-sync/remove rejects a body missing disabled", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/bundle-sync/remove",
        headers: { authorization: `Bearer ${TOKEN}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("POST /internal/uploads (issue #68)", () => {
    it("prunes uploads older than MULLION_UPLOAD_RETENTION_DAYS when a new one lands (issue #1637)", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const stale = path.join(cwd, ".mullion-uploads", "stale-uuid");
      fs.mkdirSync(stale, { recursive: true });
      const old = new Date(Date.now() - 30 * 86_400_000);
      fs.utimesSync(stale, old, old);

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&name=new.txt`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });

      expect(res.statusCode).toBe(200);
      expect(fs.existsSync(stale)).toBe(false);
      expect(fs.existsSync(res.json().path)).toBe(true);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("writes an image under <cwd>/.mullion-uploads and returns its absolute path", async () => {
      const app = await buildApp();
      // Must be within projectsRoot: this route now confines cwd via
      // resolveWithinRoots, same as /internal/actions and /internal/dock.
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const buffer = PNG_BYTES;

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: buffer,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads"))).toBe(true);
      expect(fs.readFileSync(uploadPath)).toEqual(buffer);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a cwd outside this agent's own PROJECTS_ROOTS (CodeQL: uncontrolled data in path expression)", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-upload-outside-"));

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(outsideRoots)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a mime type outside the allow-list", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fsvg%2Bxml`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/svg+xml" },
        payload: Buffer.from("<svg/>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a body whose bytes don't match the declared mime, even with an allow-listed Content-Type", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: Buffer.from("<html><script>alert(1)</script></html>"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("saves a generic file (octet-stream + name param) under the sanitized name", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const body = Buffer.from("plain log contents");

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&name=${encodeURIComponent("../server log.txt")}`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        payload: body,
      });

      expect(res.statusCode).toBe(200);
      const { path: uploadPath } = res.json();
      expect(uploadPath.startsWith(path.join(cwd, ".mullion-uploads") + path.sep)).toBe(true);
      expect(path.basename(uploadPath)).toBe("server_log.txt");
      expect(fs.readFileSync(uploadPath)).toEqual(body);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("still confines a generic-file upload's cwd to this agent's PROJECTS_ROOTS", async () => {
      const app = await buildApp();
      const outsideRoots = fs.mkdtempSync(path.join(os.tmpdir(), "internal-upload-outside-"));

      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(outsideRoots)}&name=a.txt`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(outsideRoots, ".mullion-uploads"))).toBe(false);

      fs.rmSync(outsideRoots, { recursive: true, force: true });
      await app.close();
    });

    it("does not let an image Content-Type reach generic mode just by adding a name", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&name=a.png`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: Buffer.from("<html>not a png</html>"),
      });
      expect(res.statusCode).toBe(400);
      expect(fs.existsSync(path.join(cwd, ".mullion-uploads"))).toBe(false);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("requires name for an octet-stream upload", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/octet-stream" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects an image upload with a valid cwd but neither mime nor name", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("rejects a request carrying both mime and name", async () => {
      const app = await buildApp();
      const cwd = fs.mkdtempSync(path.join(projectsRoot, "upload-"));
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=${encodeURIComponent(cwd)}&mime=image%2Fpng&name=a.png`,
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "image/png" },
        payload: PNG_BYTES,
      });
      expect(res.statusCode).toBe(400);

      fs.rmSync(cwd, { recursive: true, force: true });
      await app.close();
    });

    it("requires cwd and mime query params", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/internal/uploads",
        headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("rejects a request with no Authorization header", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/internal/uploads?cwd=%2Ftmp&mime=image%2Fpng`,
        headers: { "content-type": "image/png" },
        payload: Buffer.from("x"),
      });
      expect(res.statusCode).toBe(401);
      await app.close();
    });
  });
});

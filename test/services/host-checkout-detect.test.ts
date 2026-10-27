import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { hosts, projects } from "../../src/db/schema.js";
import {
  autoFillHostCwds,
  detectCheckouts,
  MAX_AUTOFILL_PER_RUN,
} from "../../src/services/host-checkout-detect.js";
import { HostHeartbeatTracker } from "../../src/services/host-heartbeat.js";
import { createHost } from "../../src/services/host-registry.js";
import type { DiscoveredCandidate } from "../../src/services/project-config.js";
import { parseHostCwds } from "../../src/services/placement.js";
import { parseHostCwdsMeta } from "../../src/services/host-cwds-meta.js";
import { applySettingsPatch } from "../../src/services/settings.js";

// Issue #2090 — matching a project to its clone on other hosts, and the opt-in
// auto-fill. Real DB, real local discovery on temp dirs; only the REMOTE hosts'
// discovery is faked, per host id.

const discovery = new Map<string, DiscoveredCandidate[] | Error>();
const discoverCalls: string[] = [];
let onDiscover: ((hostId: string) => void) | undefined;

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => {
        discoverCalls.push(hostId);
        onDiscover?.(hostId);
        const value = discovery.get(hostId);
        if (value instanceof Error) throw value;
        return value ?? [];
      },
    }),
  };
});

const ORIGIN = "git@github.com:acme/app.git";

function repo(name: string, over: Partial<DiscoveredCandidate> = {}): DiscoveredCandidate {
  return {
    name,
    cwd: `/Users/x/${name}`,
    isGitRepo: true,
    isWorktree: false,
    origin: "https://github.com/acme/app.git",
    ...over,
  };
}

describe("host-checkout-detect", () => {
  let app: FastifyInstance;
  let tmp: string;
  let macId: string;
  let boxId: string;

  /** A local project whose checkout has the given origin. */
  function localProject(name: string, origin: string | null = ORIGIN) {
    const cwd = path.join(tmp, name);
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    if (origin) {
      fs.writeFileSync(path.join(cwd, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
    }
    return app.db.insert(projects).values({ name, cwd, hostId: "local" }).returning().get();
  }

  function row(id: number) {
    return app.db.select().from(projects).where(eq(projects.id, id)).get()!;
  }

  function enable(on: boolean) {
    applySettingsPatch(app, { autoDetectHostCheckouts: on });
  }

  beforeEach(async () => {
    discovery.clear();
    discoverCalls.length = 0;
    onDiscover = undefined;
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "checkout-detect-"));
    app = await buildTestApp();
    await app.ready();
    const tracker = new HostHeartbeatTracker();
    app.hostHeartbeatTracker = tracker;
    macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
    boxId = createHost(app, { name: "box", baseUrl: "http://box.test", token: "t" }).id;
    tracker.recordSuccess(macId);
    tracker.recordSuccess(boxId);
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe("detectCheckouts", () => {
    it("matches a clone by its normalised origin, whatever the transport spelling", async () => {
      const project = localProject("app");
      discovery.set(macId, [repo("app")]); // https spelling vs the project's ssh one

      const found = await detectCheckouts(app, project);

      expect(found).toEqual([
        {
          hostId: macId,
          hostName: "mac",
          candidates: [{ cwd: "/Users/x/app", match: "origin" }],
          ambiguous: false,
          declined: false,
        },
      ]);
    });

    it("does not suggest a fork or an unrelated repo that merely shares the name", async () => {
      const project = localProject("app");
      discovery.set(macId, [repo("app", { origin: "git@github.com:someone-else/app.git" })]);

      expect(await detectCheckouts(app, project)).toEqual([]);
    });

    it("suggests a same-name clone with NO origin, as a name match only", async () => {
      const project = localProject("app");
      discovery.set(macId, [repo("app", { origin: null })]);

      const [s] = await detectCheckouts(app, project);

      expect(s.candidates).toEqual([{ cwd: "/Users/x/app", match: "name" }]);
    });

    it("treats an older agent (no origin field) as unknown: a name match, never an origin match", async () => {
      const project = localProject("app");
      const old: DiscoveredCandidate = { name: "app", cwd: "/Users/x/app", isGitRepo: true };
      discovery.set(macId, [old]);

      const [s] = await detectCheckouts(app, project);

      expect(s.candidates.map((c) => c.match)).toEqual(["name"]);
    });

    it("flags two clones with the project's origin as ambiguous", async () => {
      const project = localProject("app");
      discovery.set(macId, [repo("app"), repo("app-2", { cwd: "/Users/x/app-2" })]);

      const [s] = await detectCheckouts(app, project);

      expect(s.ambiguous).toBe(true);
      expect(s.candidates).toHaveLength(2);
    });

    it("never offers a linked worktree or a non-repo directory", async () => {
      const project = localProject("app");
      discovery.set(macId, [
        repo("app", { isWorktree: true, origin: null }),
        repo("app", { isGitRepo: false, origin: null, cwd: "/Users/x/plain/app" }),
      ]);

      expect(await detectCheckouts(app, project)).toEqual([]);
    });

    it("skips a host the project already has an entry for, an offline one, a drained one and a failing one", async () => {
      const project = localProject("app");
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify({ [macId]: "/already/there" }) })
        .where(eq(projects.id, project.id))
        .run();
      discovery.set(macId, [repo("app")]);
      discovery.set(boxId, new Error("boom"));

      // mac: has an entry. box: discovery fails. Neither yields a suggestion.
      expect(await detectCheckouts(app, row(project.id))).toEqual([]);

      const down = createHost(app, { name: "down", baseUrl: "http://down.test", token: "t" });
      discovery.set(down.id, [repo("app")]); // never contacted: no heartbeat yet
      const drained = createHost(app, { name: "parked", baseUrl: "http://p.test", token: "t" });
      app.hostHeartbeatTracker!.recordSuccess(drained.id);
      app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, drained.id)).run();
      discovery.set(drained.id, [repo("app")]);

      expect(await detectCheckouts(app, row(project.id))).toEqual([]);
      expect(discoverCalls).not.toContain(down.id);
      expect(discoverCalls).not.toContain(drained.id);
    });

    it("still suggests a declined host, flagged, so the one-click suggestion keeps working", async () => {
      const project = localProject("app");
      app.db
        .update(projects)
        .set({ hostCwdsMeta: JSON.stringify({ auto: [], declined: [macId] }) })
        .where(eq(projects.id, project.id))
        .run();
      discovery.set(macId, [repo("app")]);

      const [s] = await detectCheckouts(app, row(project.id));

      expect(s.declined).toBe(true);
    });

    it("takes a remote-hosted project's own origin from its host's discovery", async () => {
      const project = app.db
        .insert(projects)
        .values({ name: "app", cwd: "/srv/app", hostId: boxId })
        .returning()
        .get();
      discovery.set(boxId, [repo("app", { cwd: "/srv/app" })]);
      discovery.set(macId, [repo("app")]);

      const found = await detectCheckouts(app, project);

      expect(found.map((s) => s.hostId)).toEqual([macId]);
      expect(found[0].candidates[0].match).toBe("origin");
    });
  });

  describe("autoFillHostCwds", () => {
    it("does nothing while the setting is off (the default)", async () => {
      const project = localProject("app");
      discovery.set(macId, [repo("app")]);

      expect(await autoFillHostCwds(app)).toEqual({ enabled: false, added: [] });
      expect(row(project.id).hostCwds).toBeNull();
      expect(discoverCalls).toEqual([]);
    });

    it("maps a project onto the one matching clone, flags it auto and logs it", async () => {
      enable(true);
      const project = localProject("app");
      discovery.set(macId, [repo("app")]);
      const info = vi.spyOn(app.log, "info");

      const result = await autoFillHostCwds(app);

      expect(result).toEqual({
        enabled: true,
        added: [{ projectId: project.id, hostId: macId, cwd: "/Users/x/app" }],
      });
      expect(parseHostCwds(row(project.id).hostCwds)).toEqual({ [macId]: "/Users/x/app" });
      expect(parseHostCwdsMeta(row(project.id).hostCwdsMeta).auto).toEqual([macId]);
      expect(info).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: project.id, hostId: macId }),
        expect.stringContaining("auto-filled"),
      );
    });

    it("asks each host once however many projects there are", async () => {
      enable(true);
      localProject("app");
      localProject("other", "git@github.com:acme/other.git");
      discovery.set(macId, [repo("app")]);
      discovery.set(boxId, []);

      await autoFillHostCwds(app);

      expect(discoverCalls.filter((h) => h === macId)).toHaveLength(1);
    });

    it("never fills an ambiguous host, a declined host, a name-only match or an unknown origin", async () => {
      enable(true);
      const ambiguous = localProject("app");
      discovery.set(macId, [repo("app"), repo("app-2", { cwd: "/Users/x/app-2" })]);
      const declined = localProject("declined", "git@github.com:acme/declined.git");
      app.db
        .update(projects)
        .set({ hostCwdsMeta: JSON.stringify({ auto: [], declined: [boxId] }) })
        .where(eq(projects.id, declined.id))
        .run();
      discovery.set(boxId, [
        repo("declined", { cwd: "/srv/declined", origin: "git@github.com:acme/declined.git" }),
        repo("nameonly", { cwd: "/srv/nameonly", origin: null }),
      ]);
      const nameOnly = localProject("nameonly", "git@github.com:acme/nameonly.git");
      const noOrigin = localProject("noorigin", null);

      const result = await autoFillHostCwds(app);

      expect(result.added).toEqual([]);
      for (const p of [ambiguous, declined, nameOnly, noOrigin]) {
        expect(row(p.id).hostCwds).toBeNull();
      }
    });

    it("never overwrites an entry that appears while it runs", async () => {
      enable(true);
      const project = localProject("app");
      discovery.set(macId, [repo("app")]);
      // The operator saves their own entry for this host DURING discovery.
      onDiscover = (hostId) => {
        if (hostId !== macId) return;
        app.db
          .update(projects)
          .set({ hostCwds: JSON.stringify({ [macId]: "/operator/choice" }) })
          .where(eq(projects.id, project.id))
          .run();
      };

      const result = await autoFillHostCwds(app);

      expect(result.added).toEqual([]);
      expect(parseHostCwds(row(project.id).hostCwds)).toEqual({ [macId]: "/operator/choice" });
    });

    it("does not fill a path the API would reject (not absolute POSIX)", async () => {
      enable(true);
      const project = localProject("app");
      discovery.set(macId, [repo("app", { cwd: "C:\\Users\\x\\app" })]);

      expect((await autoFillHostCwds(app)).added).toEqual([]);
      expect(row(project.id).hostCwds).toBeNull();
    });

    it("restricts a run to one host when asked", async () => {
      enable(true);
      const project = localProject("app");
      discovery.set(macId, [repo("app")]);
      discovery.set(boxId, [repo("app", { cwd: "/srv/app" })]);

      const result = await autoFillHostCwds(app, { hostId: boxId });

      expect(result.added.map((a) => a.hostId)).toEqual([boxId]);
      expect(parseHostCwds(row(project.id).hostCwds)).toEqual({ [boxId]: "/srv/app" });
    });

    it("stops after the per-run cap", async () => {
      enable(true);
      const found: DiscoveredCandidate[] = [];
      for (let i = 0; i < MAX_AUTOFILL_PER_RUN + 5; i++) {
        const origin = `git@github.com:acme/p${i}.git`;
        localProject(`p${i}`, origin);
        found.push(
          repo(`p${i}`, { cwd: `/Users/x/p${i}`, origin: `https://github.com/acme/p${i}.git` }),
        );
      }
      discovery.set(macId, found);

      expect((await autoFillHostCwds(app)).added).toHaveLength(MAX_AUTOFILL_PER_RUN);
    });
  });
});

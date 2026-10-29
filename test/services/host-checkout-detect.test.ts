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
  attachHostCheckout,
  autoFillHostCwds,
  detectCheckouts,
  MAX_AUTOFILL_PER_RUN,
  projectOrigin,
} from "../../src/services/host-checkout-detect.js";
import { HostHeartbeatTracker } from "../../src/services/host-heartbeat.js";
import { createHost } from "../../src/services/host-registry.js";
import type { DiscoveredCandidate } from "../../src/services/project-config.js";
import { parseHostCwds } from "../../src/services/placement.js";
import { parseHostCwdsMeta } from "../../src/services/host-cwds-meta.js";
import { MAX_HOST_CWDS } from "../../src/shared/constants.js";
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
    // The DB is shared across this file's tests: start each one from the default.
    applySettingsPatch(app, { autoDetectHostCheckouts: false });
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

  describe("projectOrigin", () => {
    it("reads a local checkout's origin and a remote one through discovery", async () => {
      const project = localProject("app");
      expect(await projectOrigin(app, { hostId: "local", cwd: project.cwd })).toBe(
        "github.com/acme/app",
      );
      discovery.set(macId, [repo("app")]);
      expect(await projectOrigin(app, { hostId: macId, cwd: "/Users/x/app" })).toBe(
        "github.com/acme/app",
      );
      expect(await projectOrigin(app, { hostId: macId, cwd: "/Users/x/missing" })).toBeNull();
    });
  });

  describe("attachHostCheckout", () => {
    it("writes the path, clears auto/declined for the host, and refuses own host, limit and unknown ids", () => {
      const project = localProject("app");
      expect(attachHostCheckout(app, 99999, macId, "/Users/x/app")).toBe("not-found");
      expect(attachHostCheckout(app, project.id, "local", "/x")).toBe("own-host");

      app.db
        .update(projects)
        .set({ hostCwdsMeta: JSON.stringify({ auto: [macId], declined: [boxId] }) })
        .where(eq(projects.id, project.id))
        .run();
      expect(attachHostCheckout(app, project.id, macId, "/Users/x/app")).toBe("attached");
      expect(attachHostCheckout(app, project.id, boxId, "/srv/app")).toBe("attached");
      const after = row(project.id);
      expect(parseHostCwds(after.hostCwds)).toEqual({
        [macId]: "/Users/x/app",
        [boxId]: "/srv/app",
      });
      expect(parseHostCwdsMeta(after.hostCwdsMeta)).toEqual({ auto: [], declined: [] });
      // A different path for a mapped host is never replaced; the same one is a no-op.
      expect(attachHostCheckout(app, project.id, macId, "/elsewhere")).toBe("mapped");
      expect(attachHostCheckout(app, project.id, macId, "/Users/x/app")).toBe("attached");
    });

    it("refuses a new host once the map is full, but re-attaching an existing entry still works", () => {
      const project = localProject("app");
      const full = Object.fromEntries(
        Array.from({ length: MAX_HOST_CWDS }, (_, i) => [`h${i}`, `/p${i}`]),
      );
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify(full) })
        .where(eq(projects.id, project.id))
        .run();
      expect(attachHostCheckout(app, project.id, macId, "/new")).toBe("limit");
      expect(attachHostCheckout(app, project.id, "h0", "/p0")).toBe("attached");
    });
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

  describe("untrusted discovery replies", () => {
    it("treats a reply that is not a list as 'nothing here', and keeps going for other hosts", async () => {
      const project = localProject("app");
      discovery.set(macId, { not: "a list" } as unknown as DiscoveredCandidate[]);
      discovery.set(boxId, [repo("app", { cwd: "/srv/app" })]);

      const found = await detectCheckouts(app, project);

      expect(found.map((s) => s.hostId)).toEqual([boxId]);
    });

    it("drops malformed entries one by one instead of failing the host", async () => {
      const project = localProject("app");
      const junk = [
        null,
        42,
        "x",
        { name: 1, cwd: "/a", isGitRepo: true },
        { name: "app", cwd: null, isGitRepo: true },
        { name: "app", cwd: "/a", isGitRepo: "yes" },
        { name: "x".repeat(5000), cwd: "/a", isGitRepo: true },
        // a non-string origin reads as "no origin", so this one is a name match
        { name: "app", cwd: "/Users/x/app", isGitRepo: true, origin: 7 },
      ] as unknown as DiscoveredCandidate[];
      discovery.set(macId, junk);

      const [s] = await detectCheckouts(app, project);

      expect(s.candidates).toEqual([{ cwd: "/Users/x/app", match: "name" }]);
    });

    it("never auto-fills a path that is not safe to store", async () => {
      enable(true);
      const cases = ["/ok/../etc", "/line\nbreak", `/${"a".repeat(5000)}`];
      for (const [i, cwd] of cases.entries()) {
        const project = localProject(`unsafe${i}`, `git@github.com:acme/unsafe${i}.git`);
        discovery.set(macId, [
          repo(`unsafe${i}`, { cwd, origin: `https://github.com/acme/unsafe${i}.git` }),
        ]);

        expect((await autoFillHostCwds(app, { hostId: macId })).added, cwd.slice(0, 20)).toEqual(
          [],
        );
        expect(row(project.id).hostCwds).toBeNull();
      }
    });

    it("does not even suggest a path the sweep would refuse to store", async () => {
      const project = localProject("app");
      discovery.set(macId, [
        repo("app", { cwd: "relative/app" }),
        repo("app", { cwd: "/ok/../etc/app" }),
        repo("app", { cwd: "/with\nnewline/app" }),
      ]);

      expect(await detectCheckouts(app, project)).toEqual([]);

      discovery.set(macId, [repo("app", { cwd: "/Users/x/app" })]);
      expect((await detectCheckouts(app, project))[0].candidates[0].cwd).toBe("/Users/x/app");
    });

    it("caps how many entries it reads from one host", async () => {
      const project = localProject("app");
      const many: DiscoveredCandidate[] = Array.from({ length: 3000 }, (_, i) => ({
        name: `r${i}`,
        cwd: `/Users/x/r${i}`,
        isGitRepo: true,
        isWorktree: false,
        origin: null,
      }));
      // The real clone sits past the cap, so it is (deliberately) not seen.
      many.push(repo("app"));
      discovery.set(macId, many);

      expect(await detectCheckouts(app, project)).toEqual([]);
    });
  });

  describe("auto-fill limits", () => {
    it("does not add a 33rd host to a full hostCwds map", async () => {
      enable(true);
      const project = localProject("app");
      const full = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`h${i}`, `/p/${i}`]));
      app.db
        .update(projects)
        .set({ hostCwds: JSON.stringify(full) })
        .where(eq(projects.id, project.id))
        .run();
      discovery.set(macId, [repo("app")]);

      expect((await autoFillHostCwds(app)).added).toEqual([]);
      expect(Object.keys(parseHostCwds(row(project.id).hostCwds))).toHaveLength(32);
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

    it("says WHY a one-host run found nothing: the host is offline, or parked", async () => {
      enable(true);
      localProject("app");
      const down = createHost(app, { name: "down", baseUrl: "http://down.test", token: "t" });
      const parked = createHost(app, { name: "parked", baseUrl: "http://p.test", token: "t" });
      app.hostHeartbeatTracker!.recordSuccess(parked.id);
      app.db.update(hosts).set({ drained: true }).where(eq(hosts.id, parked.id)).run();

      expect(await autoFillHostCwds(app, { hostId: down.id })).toEqual({
        enabled: true,
        added: [],
        skipped: "offline",
      });
      expect(await autoFillHostCwds(app, { hostId: parked.id })).toEqual({
        enabled: true,
        added: [],
        skipped: "drained",
      });
      // An online host with nothing to find is NOT "skipped".
      discovery.set(macId, []);
      expect(await autoFillHostCwds(app, { hostId: macId })).toEqual({ enabled: true, added: [] });
      expect(discoverCalls).not.toContain(down.id);
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

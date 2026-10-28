import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type * as RemoteHostClientModule from "../../src/services/remote-host-client.js";
import { buildTestApp } from "../helpers/app.js";
import { projects } from "../../src/db/schema.js";
import { createHost } from "../../src/services/host-registry.js";
import type { DiscoveredCandidate } from "../../src/services/project-config.js";
import {
  buildOriginIndex,
  findProjectByRepoIdentity,
  projectHasPath,
} from "../../src/services/repo-identity.js";
import { serializeHostCwds } from "../../src/services/placement.js";

// Issue #2231 — finding the project a checkout already belongs to. Real DB and
// real local git configs; only a remote host's discovery is faked.

const discovery = new Map<string, DiscoveredCandidate[] | Error>();

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteHostClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      discover: async () => {
        const value = discovery.get(hostId);
        if (value instanceof Error) throw value;
        return value ?? [];
      },
    }),
  };
});

const ORIGIN = "git@github.com:acme/app.git";

describe("repo-identity", () => {
  let app: FastifyInstance;
  let tmp: string;
  let macId: string;

  function localProject(name: string, origin: string | null = ORIGIN) {
    const cwd = path.join(tmp, name);
    fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
    if (origin) {
      fs.writeFileSync(path.join(cwd, ".git", "config"), `[remote "origin"]\n\turl = ${origin}\n`);
    }
    return app.db.insert(projects).values({ name, cwd, hostId: "local" }).returning().get();
  }

  beforeEach(async () => {
    discovery.clear();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repo-identity-"));
    app = await buildTestApp();
    await app.ready();
    // The DB is shared across this file's tests: start each one empty.
    app.db.delete(projects).run();
    macId = createHost(app, { name: "mac", baseUrl: "http://mac.test", token: "t" }).id;
  });

  afterEach(async () => {
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("matches a path equal to a project's cwd on its own host only", async () => {
    const p = localProject("app", null);
    expect((await findProjectByRepoIdentity(app, { hostId: "local", cwd: p.cwd }))?.reason).toBe(
      "path",
    );
    expect(await findProjectByRepoIdentity(app, { hostId: macId, cwd: p.cwd })).toBeNull();
  });

  it("matches a path listed in a project's hostCwds", async () => {
    const p = localProject("app", null);
    app.db
      .update(projects)
      .set({ hostCwds: serializeHostCwds({ [macId]: "/Users/x/app" }) })
      .where(eq(projects.id, p.id))
      .run();
    const match = await findProjectByRepoIdentity(app, { hostId: macId, cwd: "/Users/x/app" });
    expect(match).toMatchObject({ reason: "path", project: { id: p.id } });
    const fresh = app.db.select().from(projects).where(eq(projects.id, p.id)).get()!;
    expect(projectHasPath(fresh, macId, "/Users/x/app")).toBe(true);
    expect(projectHasPath(fresh, macId, "/Users/x/other")).toBe(false);
  });

  it("matches by normalised origin across spellings and forges", async () => {
    const p = localProject("app");
    const match = await findProjectByRepoIdentity(app, {
      hostId: macId,
      cwd: "/Users/x/clone",
      origin: "https://GitHub.com/acme/app",
    });
    expect(match).toMatchObject({ reason: "origin", project: { id: p.id } });

    const other = await findProjectByRepoIdentity(app, {
      hostId: macId,
      cwd: "/Users/x/clone",
      origin: "https://github.com/acme/else.git",
    });
    expect(other).toBeNull();
  });

  it("looks the candidate's origin up on a remote host when none is given", async () => {
    const p = localProject("app");
    discovery.set(macId, [
      { name: "app", cwd: "/Users/x/app", isGitRepo: true, origin: "git@github.com:acme/app" },
    ]);
    const match = await findProjectByRepoIdentity(app, { hostId: macId, cwd: "/Users/x/app" });
    expect(match).toMatchObject({ reason: "origin", project: { id: p.id } });
  });

  it("falls back to path-only matching when the host is unreachable or the origin is null", async () => {
    localProject("app");
    discovery.set(macId, new Error("offline"));
    expect(await findProjectByRepoIdentity(app, { hostId: macId, cwd: "/Users/x/app" })).toBeNull();
    expect(
      await findProjectByRepoIdentity(app, { hostId: macId, cwd: "/x", origin: null }),
    ).toBeNull();
  });

  it("excludes the project being edited", async () => {
    const p = localProject("app");
    expect(
      await findProjectByRepoIdentity(app, {
        hostId: "local",
        cwd: p.cwd,
        excludeProjectId: p.id,
      }),
    ).toBeNull();
  });

  it("buildOriginIndex reads each project's origin, null when it cannot be told", async () => {
    const withOrigin = localProject("a");
    const without = localProject("b", null);
    const index = await buildOriginIndex(app);
    expect(index.get(withOrigin.id)).toBe("github.com/acme/app");
    expect(index.get(without.id)).toBeNull();
  });
});

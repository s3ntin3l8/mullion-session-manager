import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { buildTestApp } from "../helpers/app.js";
import { projects } from "../../src/db/schema.js";
import type * as RemoteClientModule from "../../src/services/remote-host-client.js";
import type * as HostGitModule from "../../src/services/host-git.js";
import type * as GithubIntegrationModule from "../../src/services/github-integration.js";

// Auto-fetch of Mullion-managed checkouts on the project's OTHER hosts
// (hostCwdsMeta.managed). A fake remote host client records which
// (host, cwd, token) the sweep fetched.

const fetched: Array<{ hostId: string; cwd: string; token?: string }> = [];

vi.mock("../../src/services/remote-host-client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof RemoteClientModule>();
  return {
    ...actual,
    getRemoteHostClient: (_app: unknown, hostId: string) => ({
      resolveGitFetch: async (cwd: string, token?: string) => {
        fetched.push({ hostId, cwd, token });
        return { success: true };
      },
    }),
  };
});
vi.mock("../../src/services/host-git.js", async (importOriginal) => ({
  ...(await importOriginal<typeof HostGitModule>()),
  resolveRepoRef: async () => ({ owner: "o", repo: "r" }),
}));
vi.mock("../../src/services/github-integration.js", async (importOriginal) => ({
  ...(await importOriginal<typeof GithubIntegrationModule>()),
  resolveGitHubToken: async () => "ghs_secret",
}));

async function waitUntil(check: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("condition never became true");
}

describe("gitFetcherPlugin: managed checkouts on other hosts", () => {
  beforeEach(() => {
    fetched.length = 0;
  });
  afterEach(() => vi.restoreAllMocks());

  async function setup(autoFetch: boolean) {
    const app = await buildTestApp();
    // The test DB is shared across this file's tests: drop the previous
    // test's project so its managed checkouts are not swept again.
    app.db.delete(projects).run();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { allowDuplicate: true, name: "managed-fetch", cwd: "/tmp" },
    });
    app.db
      .update(projects)
      .set({
        autoFetch,
        hostCwds: JSON.stringify({ hostA: "/r/a", hostB: "/r/b", hostC: "/r/c", hostD: "/r/d" }),
        hostCwdsMeta: JSON.stringify({
          auto: ["hostD"],
          declined: [],
          managed: ["hostA", "hostC"],
        }),
      })
      .where(eq(projects.id, created.json().id))
      .run();
    const online = new Set(["hostA", "hostB", "hostD"]);
    (app as unknown as { hostHeartbeatTracker: unknown }).hostHeartbeatTracker = {
      getHealth: (id: string) => ({ status: online.has(id) ? "online" : "offline" }),
    };
    return app;
  }

  it("fetches only managed, online hosts, with the read token", async () => {
    const app = await setup(true);
    app.reconfigureGitFetcher(1);
    await waitUntil(() => fetched.length > 0);
    await new Promise((r) => setTimeout(r, 300));
    // hostB is user-mapped, hostD auto-detected, hostC managed but offline.
    expect(fetched.map((f) => f.hostId)).toEqual(["hostA"]);
    expect(fetched[0]).toEqual({ hostId: "hostA", cwd: "/r/a", token: "ghs_secret" });
    app.reconfigureGitFetcher(0);
  });

  it("skips every host of a project with auto_fetch=false", async () => {
    const app = await setup(false);
    app.reconfigureGitFetcher(1);
    await new Promise((r) => setTimeout(r, 2500));
    expect(fetched).toEqual([]);
    app.reconfigureGitFetcher(0);
  });
});

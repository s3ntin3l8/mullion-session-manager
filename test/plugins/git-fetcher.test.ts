import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildTestApp } from "../helpers/app.js";
import { LOCAL_HOST_ID } from "../../src/services/host-registry.js";
import { markCloneBusy, releaseClone } from "../../src/services/git-clone-busy.js";
import { cloneWithRemote, hasFetched } from "../helpers/git-clone.js";

// The auto-fetch sweep and the clone REPAIR (issue #1896) both run `git
// fetch` on the same clone, and the repair also rewrites its indexes — so a
// sweep landing inside a repair's fetch window would fail the repair's ref
// update and make a healthy clone look broken. They therefore share ONE
// registry of the clones with a git operation in flight, and these tests
// exercise that: the sweep skips a clone the repair has claimed, and fetches
// one it has not.

async function waitUntil(check: () => boolean, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition never became true");
}

describe("gitFetcherPlugin: the clone it shares with the repair (issue #1896)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fetches a clone that nothing else has claimed", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-fetcher-"));
    const { repo, fetchedHead } = cloneWithRemote(base);
    dirs.push(base);
    const app = await buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "fetcher-repo", cwd: repo },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${created.json().id}`,
      payload: { autoFetch: true },
    });

    // A one-second tick, so the test does not wait out the real interval.
    app.reconfigureGitFetcher(1);
    await waitUntil(() => hasFetched(repo, fetchedHead));
  });

  it("skips a clone a git operation has already claimed", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "git-fetcher-"));
    const { repo, fetchedHead } = cloneWithRemote(base);
    dirs.push(base);

    // Stand in for a repair, which claims the clone before it fetches. The
    // claim happens BEFORE the project exists, so no sweep tick can slip in
    // between the project being auto-fetch-enabled and the clone being
    // claimed.
    markCloneBusy(LOCAL_HOST_ID, repo);
    const app = await buildTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "fetcher-busy-repo", cwd: repo },
    });
    await app.inject({
      method: "PATCH",
      url: `/api/projects/${created.json().id}`,
      payload: { autoFetch: true },
    });

    try {
      app.reconfigureGitFetcher(1);
      // Give the sweep a couple of ticks to (not) fetch. The assertion is on
      // the ABSENCE of the ref, so a slow host only makes it pass later.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      expect(hasFetched(repo, fetchedHead)).toBe(false);
    } finally {
      releaseClone(LOCAL_HOST_ID, repo);
    }
  });
});

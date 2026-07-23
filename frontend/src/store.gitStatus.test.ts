// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useDashboardStore } from "./store.js";
import type { GitStatus, Project } from "./api.js";

// Mirrors Dock.test.tsx's fake-in-memory-backend pattern: a mocked global
// fetch driving the real store method under test (refreshGitStatuses),
// rather than mocking api.ts itself.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT_1: Project = {
  id: 1,
  name: "one",
  cwd: "/home/x/one",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROJECT_2: Project = {
  ...PROJECT_1,
  id: 2,
  name: "two",
  cwd: "/home/x/two",
};

const CLEAN_STATUS: GitStatus = {
  branch: "main",
  hash: "abc1234",
  ahead: 0,
  behind: 0,
  files: [],
  isClean: true,
  hasConflicts: false,
};

// Fixture responses keyed by project id, mutated per-test. The mock builds a
// batch response from these per-project entries — projects without an entry
// are omitted (simulating a transient failure / 503-equivalent).
let responseByProject: Record<number, () => Response>;

describe("store.refreshGitStatuses (transient-failure last-known-good)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    responseByProject = {};
    fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      // `sessionIds=` is optional and this store slice's own tests never set
      // any sessions, so it's matched but ignored here — every request this
      // suite issues has an empty sessions map in the response.
      const match = /^\/api\/projects\/git-statuses\?ids=([\d,]+)(?:&sessionIds=[\d,]*)?$/.exec(
        url,
      );
      if (match) {
        const ids = match[1].split(",").map(Number);
        const body: Record<string, GitStatus | null> = {};
        for (const id of ids) {
          const respond = responseByProject[id];
          if (respond) {
            const res = respond();
            if (res.status === 200) {
              body[String(id)] = (await res.json()) as GitStatus;
            } else if (res.status === 204) {
              body[String(id)] = null;
            }
          }
          // Project omitted from body => transient failure (503-equivalent)
        }
        return jsonResponse(200, { projects: body, sessions: {} });
      }
      throw new Error(`unhandled fetch in test: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT_1, PROJECT_2], gitStatuses: {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes null for a durable 204 (not a git repo)", async () => {
    responseByProject[1] = () => new Response(null, { status: 204 });
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toBeNull();
  });

  it("writes the fetched status on success", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
  });

  it("preserves the previous entry on a transient failure, instead of blanking it to null", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);

    // Next tick: git status fails transiently (e.g. index.lock contention).
    // The batch omits project 1 from the response => the store keeps the
    // last-known-good status rather than clearing it.
    delete responseByProject[1];
    await useDashboardStore.getState().refreshGitStatuses();

    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
  });

  it("preserves the previous entry across a raw network error too", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);

    // Entire batch request fails (network down) — no entries are touched.
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
  });

  it("only blanks to null via a later durable 204, and only for that project", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    responseByProject[2] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();

    // Project 1 becomes genuinely not-a-repo (null in batch response);
    // project 2 is omitted (transient failure) — must preserve its previous.
    responseByProject[1] = () => new Response(null, { status: 204 });
    delete responseByProject[2];
    await useDashboardStore.getState().refreshGitStatuses();

    expect(useDashboardStore.getState().gitStatuses[1]).toBeNull();
    expect(useDashboardStore.getState().gitStatuses[2]).toEqual(CLEAN_STATUS);
  });

  it("prunes orphaned entries when a project is removed from the list", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    responseByProject[2] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
    expect(useDashboardStore.getState().gitStatuses[2]).toEqual(CLEAN_STATUS);

    // Remove project 1 from the store's project list to simulate deletion.
    useDashboardStore.setState({ projects: [PROJECT_2] });
    await useDashboardStore.getState().refreshGitStatuses();

    // Project 1's stale entry should be pruned since it's no longer in the
    // project list; project 2's status is still returned by the batch.
    expect(useDashboardStore.getState().gitStatuses[1]).toBeUndefined();
    expect(useDashboardStore.getState().gitStatuses[2]).toEqual(CLEAN_STATUS);
  });

  it("dedups overlapping calls into a single in-flight fetch batch (Hermes review, PR #164)", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    responseByProject[2] = () => jsonResponse(200, CLEAN_STATUS);

    // Two calls fired without awaiting the first — simulates a slow tick
    // still in flight when the next tick's call starts. Without dedup, this
    // would issue 2 fetches; with it, the second call reuses the first's
    // in-flight promise.
    const first = useDashboardStore.getState().refreshGitStatuses();
    const second = useDashboardStore.getState().refreshGitStatuses();
    expect(second).toBe(first);
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
    expect(useDashboardStore.getState().gitStatuses[2]).toEqual(CLEAN_STATUS);

    // A later call (after the first batch has fully settled) is a fresh,
    // independent fetch batch again, not permanently deduped.
    const third = useDashboardStore.getState().refreshGitStatuses();
    expect(third).not.toBe(first);
    await third;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

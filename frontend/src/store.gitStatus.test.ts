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

// Fixture responses keyed by project id, mutated per-test.
let responseByProject: Record<number, () => Response>;

describe("store.refreshGitStatuses (transient-failure last-known-good)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    responseByProject = {};
    fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const match = /^\/api\/projects\/(\d+)\/git-status$/.exec(url);
      if (match) {
        const id = Number(match[1]);
        const respond = responseByProject[id];
        return Promise.resolve(respond ? respond() : new Response(null, { status: 204 }));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${url}`));
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

  it("preserves the previous entry on a transient 503, instead of blanking it to null", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);

    // Next tick: git status fails transiently (e.g. index.lock contention).
    responseByProject[1] = () => jsonResponse(503, { message: "unavailable" });
    await useDashboardStore.getState().refreshGitStatuses();

    // This is the flicker fix: a single failed poll tick must not overwrite
    // the last-known-good status with null.
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
  });

  it("preserves the previous entry across a raw network error too", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);

    // Project 1's fetch is the first call `refreshGitStatuses` makes (array
    // order is preserved by Promise.all(projects.map(...))), so overriding
    // just the next call reliably targets it.
    fetchMock.mockImplementationOnce(() => Promise.reject(new Error("network down")));
    await useDashboardStore.getState().refreshGitStatuses();
    expect(useDashboardStore.getState().gitStatuses[1]).toEqual(CLEAN_STATUS);
  });

  it("only blanks to null via a later durable 204, and only for that project", async () => {
    responseByProject[1] = () => jsonResponse(200, CLEAN_STATUS);
    responseByProject[2] = () => jsonResponse(200, CLEAN_STATUS);
    await useDashboardStore.getState().refreshGitStatuses();

    // Project 1 becomes genuinely not-a-repo; project 2's transient failure
    // must not affect project 1, and project 1's real 204 must still clear.
    responseByProject[1] = () => new Response(null, { status: 204 });
    responseByProject[2] = () => jsonResponse(503, { message: "unavailable" });
    await useDashboardStore.getState().refreshGitStatuses();

    expect(useDashboardStore.getState().gitStatuses[1]).toBeNull();
    expect(useDashboardStore.getState().gitStatuses[2]).toEqual(CLEAN_STATUS);
  });
});

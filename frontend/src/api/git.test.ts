// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { gitApi } from "./git.js";

afterEach(() => vi.unstubAllGlobals());

function stubFetch() {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return () => {
    const call = fetchMock.mock.calls.at(-1)!;
    return { url: String(call[0]), method: (call[1] as RequestInit | undefined)?.method };
  };
}

describe("session-scoped git requests", () => {
  it("adds sessionId only when a session checkout is named", async () => {
    const last = stubFetch();
    await gitApi.getProjectGitStatus(4);
    expect(last().url).toBe("/api/projects/4/git-status");
    await gitApi.getProjectGitStatus(4, { fresh: true, sessionId: 9 });
    expect(last().url).toBe("/api/projects/4/git-status?fresh=1&sessionId=9");
    await gitApi.postProjectGitFetch(4);
    expect(last().url).toBe("/api/projects/4/git-fetch");
    await gitApi.postProjectGitFetch(4, 9);
    expect(last()).toEqual({ url: "/api/projects/4/git-fetch?sessionId=9", method: "POST" });
    await gitApi.postProjectGitPull(4, 9);
    expect(last().url).toBe("/api/projects/4/git-pull?sessionId=9");
  });

  it("diffs by project or by session, never both", async () => {
    const last = stubFetch();
    await gitApi.getProjectGitFileDiff(4, "a b.ts");
    expect(last().url).toBe("/api/projects/git-file-diff?projectId=4&path=a%20b.ts");
    await gitApi.getProjectGitFileDiff(4, "a.ts", 9);
    expect(last().url).toBe("/api/projects/git-file-diff?sessionId=9&path=a.ts");
  });
});

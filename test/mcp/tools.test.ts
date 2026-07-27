import { describe, it, expect, vi } from "vitest";
import { TOOLS } from "../../src/mcp/tools.mjs";

// Issue #271 — unit tests for the `mullion mcp` tool registry against a
// fake MullionClient (real transport is covered by client.test.ts) — the
// registry shape itself (name/description/inputSchema/handler) is what
// issue #134's later tools plug into, so this also documents that contract.

function fakeClient(promoteRequestResult: unknown) {
  return { promoteRequest: vi.fn().mockResolvedValue(promoteRequestResult) };
}

describe("TOOLS registry (issue #271)", () => {
  it("registers exactly three tools today: promote_to_worktree, use_browser, browser_action", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "promote_to_worktree",
      "use_browser",
      "browser_action",
    ]);
  });

  it("promote_to_worktree declares a JSON Schema requiring summary", () => {
    const tool = TOOLS.find((t) => t.name === "promote_to_worktree")!;
    expect(tool.inputSchema).toMatchObject({
      type: "object",
      required: ["summary"],
      properties: { summary: expect.any(Object), suggestedBaseRef: expect.any(Object) },
    });
  });
});

describe("promote_to_worktree handler (issue #271)", () => {
  const tool = TOOLS.find((t) => t.name === "promote_to_worktree")!;

  it("calls client.promoteRequest with the given summary and suggestedBaseRef", async () => {
    const client = fakeClient({ decision: "declined" });
    await tool.handler({ summary: "start work", suggestedBaseRef: "main" }, client);
    expect(client.promoteRequest).toHaveBeenCalledWith("start work", "main");
  });

  it("treats a missing summary as an empty string rather than throwing", async () => {
    const client = fakeClient({ decision: "declined" });
    await tool.handler({}, client);
    expect(client.promoteRequest).toHaveBeenCalledWith("", undefined);
  });

  it("describes an accepted decision, including the worktree path and new session id", async () => {
    const client = fakeClient({
      decision: "accepted",
      worktreePath: "/tmp/.mullion-worktrees/foo",
      newSessionId: 7,
    });
    const text = await tool.handler({ summary: "start work" }, client);
    expect(text).toContain("Approved");
    expect(text).toContain("/tmp/.mullion-worktrees/foo");
    expect(text).toContain("session 7");
  });

  it("describes an accepted decision gracefully when worktreePath/newSessionId are absent", async () => {
    const client = fakeClient({ decision: "accepted", worktreePath: null, newSessionId: null });
    const text = await tool.handler({ summary: "start work" }, client);
    expect(text).toContain("Approved");
    expect(text).not.toContain("null");
  });

  it("describes a declined decision with its reason", async () => {
    const client = fakeClient({ decision: "declined", reason: "not now" });
    const text = await tool.handler({ summary: "start work" }, client);
    expect(text).toContain("Declined");
    expect(text).toContain("not now");
  });

  it("describes a declined decision with no reason gracefully", async () => {
    const client = fakeClient({ decision: "declined" });
    const text = await tool.handler({ summary: "start work" }, client);
    expect(text).toContain("Declined");
  });
});

describe("use_browser and browser_action handlers (Feature 3.7)", () => {
  const useBrowserTool = TOOLS.find((t) => t.name === "use_browser")!;
  const browserActionTool = TOOLS.find((t) => t.name === "browser_action")!;

  it("calls client.browserAction with the given action payload", async () => {
    const mockResult = { ok: true, url: "http://example.com" };
    const browserActionSpy = vi.fn().mockResolvedValue(mockResult);
    const client = { browserAction: browserActionSpy };

    const args = { action: "navigate", url: "http://example.com" };
    const text1 = await useBrowserTool.handler(args, client);
    expect(browserActionSpy).toHaveBeenCalledWith(args);
    expect(JSON.parse(text1)).toEqual(mockResult);

    const text2 = await browserActionTool.handler(args, client);
    expect(browserActionSpy).toHaveBeenLastCalledWith(args);
    expect(JSON.parse(text2)).toEqual(mockResult);
  });
});

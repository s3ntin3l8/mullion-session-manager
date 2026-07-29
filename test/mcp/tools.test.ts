import { describe, it, expect, vi } from "vitest";
import { TOOLS } from "../../src/mcp/tools.mjs";

// Issue #271 — unit tests for the `mullion mcp` tool registry against a
// fake MullionClient (real transport is covered by client.test.ts) — the
// registry shape itself (name/description/inputSchema/handler) is what
// issue #134's later tools plug into, so this also documents that contract.

function fakeClient(promoteRequestResult: unknown) {
  return { promoteRequest: vi.fn().mockResolvedValue(promoteRequestResult) };
}

describe("TOOLS registry (issue #271, #134 part 2)", () => {
  it("registers the full tool set, in order", () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      "promote_to_worktree",
      "use_browser",
      "browser_action",
      "list_sessions",
      "start_dock_session",
      "stop_dock_session",
      "get_scrollback",
      "list_projects",
      "list_actions",
      "create_preview",
      "delete_preview",
    ]);
  });

  it("does not register a list_previews tool — no backing previews.list op exists (PR6 precedent)", () => {
    expect(TOOLS.map((t) => t.name)).not.toContain("list_previews");
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

describe("session/project/preview tool handlers (issue #134 part 2)", () => {
  it("list_sessions calls client.listSessions with projectId/kind and returns JSON", async () => {
    const tool = TOOLS.find((t) => t.name === "list_sessions")!;
    const listSessions = vi.fn().mockResolvedValue([{ id: 1 }]);
    const text = await tool.handler({ projectId: "3", kind: "dock" }, { listSessions });
    expect(listSessions).toHaveBeenCalledWith({ projectId: "3", kind: "dock" });
    expect(JSON.parse(text)).toEqual([{ id: 1 }]);
  });

  it("start_dock_session calls client.startDockSession with projectId and dockControlId", async () => {
    const tool = TOOLS.find((t) => t.name === "start_dock_session")!;
    const startDockSession = vi.fn().mockResolvedValue({ id: 42 });
    const text = await tool.handler(
      { projectId: "3", dockControlId: "vite" },
      { startDockSession },
    );
    expect(startDockSession).toHaveBeenCalledWith("3", "vite");
    expect(JSON.parse(text)).toEqual({ id: 42 });
  });

  it("stop_dock_session calls client.stopDockSession with sessionId", async () => {
    const tool = TOOLS.find((t) => t.name === "stop_dock_session")!;
    const stopDockSession = vi.fn().mockResolvedValue({ ok: true });
    const text = await tool.handler({ sessionId: "9" }, { stopDockSession });
    expect(stopDockSession).toHaveBeenCalledWith("9");
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  it("get_scrollback calls client.getScrollback with sessionId, defaulting to undefined", async () => {
    const tool = TOOLS.find((t) => t.name === "get_scrollback")!;
    const getScrollback = vi.fn().mockResolvedValue({ b64: "abc" });
    const text = await tool.handler({}, { getScrollback });
    expect(getScrollback).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(text)).toEqual({ b64: "abc" });
  });

  it("list_projects calls client.listProjects with no arguments", async () => {
    const tool = TOOLS.find((t) => t.name === "list_projects")!;
    const listProjects = vi.fn().mockResolvedValue([{ id: 1, name: "demo" }]);
    const text = await tool.handler({}, { listProjects });
    expect(listProjects).toHaveBeenCalledWith();
    expect(JSON.parse(text)).toEqual([{ id: 1, name: "demo" }]);
  });

  it("list_actions calls client.listActions with projectId, defaulting to undefined", async () => {
    const tool = TOOLS.find((t) => t.name === "list_actions")!;
    const listActions = vi.fn().mockResolvedValue([]);
    const text = await tool.handler({}, { listActions });
    expect(listActions).toHaveBeenCalledWith(undefined);
    expect(JSON.parse(text)).toEqual([]);
  });

  describe("create_preview", () => {
    const tool = TOOLS.find((t) => t.name === "create_preview")!;

    it("calls client.createPreview with projectId when given", async () => {
      const createPreview = vi.fn().mockResolvedValue({ slug: "abc" });
      const text = await tool.handler({ projectId: "3" }, { createPreview });
      expect(createPreview).toHaveBeenCalledWith({ projectId: "3", url: undefined });
      expect(JSON.parse(text)).toEqual({ slug: "abc" });
    });

    it("calls client.createPreview with url when given", async () => {
      const createPreview = vi.fn().mockResolvedValue({ slug: "abc" });
      await tool.handler({ url: "http://example.com" }, { createPreview });
      expect(createPreview).toHaveBeenCalledWith({
        projectId: undefined,
        url: "http://example.com",
      });
    });

    // The mutual-exclusivity guard itself lives in client.createPreview, not
    // this handler (see client.mjs/client.test.ts) — so a mocked
    // createPreview here would never reproduce the real throw. This handler
    // only maps args through and lets whatever createPreview does propagate.
  });

  it("delete_preview calls client.deletePreview with slug", async () => {
    const tool = TOOLS.find((t) => t.name === "delete_preview")!;
    const deletePreview = vi.fn().mockResolvedValue({ ok: true });
    const text = await tool.handler({ slug: "abc" }, { deletePreview });
    expect(deletePreview).toHaveBeenCalledWith("abc");
    expect(JSON.parse(text)).toEqual({ ok: true });
  });
});

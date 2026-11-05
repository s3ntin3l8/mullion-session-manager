// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { FileEditorPanel } from "./FileEditorPanel.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";

// The CodeMirror editor is not under test here; a stub keeps the import light.
vi.mock("./components/CodeEditor.js", () => ({ CodeEditor: () => null }));

describe("FileEditorPanel across hosts", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers a root for a session on another host at the project's own path", async () => {
    useDashboardStore.setState({
      projects: [{ id: 1, name: "p", cwd: "/proj", hostId: "local" }] as never,
      hosts: [{ id: "mac", name: "Mac mini" }] as never,
      sessions: [
        { id: 7, projectId: 1, status: "active", cwd: "/proj", resolvedHostId: "mac" },
        { id: 8, projectId: 1, status: "active", cwd: "/proj", resolvedHostId: "local" },
      ] as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, {
            path: "",
            entries: [{ name: ".env", kind: "file", size: 1 }],
            truncated: false,
          }),
        ),
      ),
    );
    render(<FileEditorPanel params={{ projectId: 1 }} />);
    await screen.findByText(".env");
    expect(screen.getByRole("option", { name: "Worktree: proj on Mac mini" })).toBeInTheDocument();
    // The local session is in the project's own checkout: no root of its own.
    expect(screen.getAllByRole("option")).toHaveLength(2);
  });
});

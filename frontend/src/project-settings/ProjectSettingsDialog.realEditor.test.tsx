// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject } from "../test/fixtures.js";
import { ProjectSettingsHost } from "./ProjectSettingsDialog.js";

// #3406 — the dialog's draft protection with the REAL Agent Rules editor, so
// its dirty reporting (not a stub's) is what is pinned.
const TARGET = {
  id: "claude-code:project",
  agent: "claude-code",
  agentLabel: "Claude Code",
  scope: "project",
  fileName: "CLAUDE.md",
  absolutePath: "/repo/CLAUDE.md",
  exists: true,
  size: 5,
  mtimeMs: 1,
  status: "active",
  content: "rules",
  truncated: false,
  isSymlink: false,
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) =>
      Promise.resolve(
        String(input).includes("/agent-rules")
          ? jsonResponse(200, [TARGET])
          : jsonResponse(200, []),
      ),
    ),
  );
  useDashboardStore.setState({
    projects: [makeProject({ id: 5, name: "mullion" })],
    projectSettings: null,
    projectSettingsDirty: false,
    projectSettingsLeave: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Project settings with the real Agent Rules editor", () => {
  it("asks before closing over an unsaved edit", async () => {
    const user = userEvent.setup();
    render(<ProjectSettingsHost />);
    act(() => useDashboardStore.getState().openProjectSettings(5, "agent-rules"));

    await user.click(await screen.findByText("CLAUDE.md"));
    await user.type(await screen.findByRole("textbox"), " more");
    expect(useDashboardStore.getState().projectSettingsDirty).toBe(true);

    await user.click(screen.getByRole("button", { name: "Close project settings" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Unsaved changes in Agent Rules.");
    expect(screen.getByRole("dialog", { name: /Project settings/ })).toBeInTheDocument();
  });
});

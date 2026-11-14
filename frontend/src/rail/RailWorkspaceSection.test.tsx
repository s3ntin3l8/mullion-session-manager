// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RailWorkspaceSection } from "./RailWorkspaceSection.js";
import type { RailWorkspaceSectionProps } from "./RailWorkspaceSection.js";

vi.mock("./WorkspaceChip.js", () => ({
  WorkspaceChip: ({ sheet }: { sheet: boolean }) => (
    <button data-testid="chip" data-sheet={String(sheet)} />
  ),
}));

function renderSection(over: Partial<RailWorkspaceSectionProps> = {}) {
  const props: RailWorkspaceSectionProps = {
    onSelectWorkspace: vi.fn(),
    sheet: false,
    showPanes: true,
    panes: [{ id: "browser-1", title: "Preview", sessionId: undefined }],
    activePanelId: null,
    onFocusPane: vi.fn(),
    onNewSession: vi.fn(),
    ...over,
  };
  render(<RailWorkspaceSection {...props} />);
  return props;
}

describe("RailWorkspaceSection", () => {
  it("lists the open panes under the chip while the sidebar is not showing", async () => {
    const user = userEvent.setup();
    const props = renderSection({ sheet: true });
    expect(screen.getByTestId("chip")).toHaveAttribute("data-sheet", "true");
    await user.click(screen.getByRole("button", { name: "Preview" }));
    expect(props.onFocusPane).toHaveBeenCalledWith("browser-1");
    await user.click(screen.getByRole("button", { name: "New session" }));
    expect(props.onNewSession).toHaveBeenCalledTimes(1);
  });

  it("shows only the chip while the sidebar is showing", () => {
    renderSection({ showPanes: false });
    expect(screen.getByTestId("chip")).toBeInTheDocument();
    expect(screen.queryByRole("group", { name: "Open panes" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New session" })).toBeNull();
  });
});

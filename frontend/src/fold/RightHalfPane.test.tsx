// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightHalfPane } from "./RightHalfPane.js";
import { HalfHeader } from "./HalfHeader.js";

// The terminal itself has its own suite; here it only has to show which
// session it was given and whether it is the active one.
vi.mock("../TerminalPane.js", () => ({
  TerminalPane: (p: { params: { sessionId: number }; active?: boolean }) => (
    <div
      data-testid="terminal"
      data-session={p.params.sessionId}
      data-active={String(!!p.active)}
    />
  ),
}));

describe("RightHalfPane", () => {
  function renderPane(focused = false) {
    const props = {
      sessionId: 6,
      title: "Dark mode palette",
      projectName: "aurora-web",
      focused,
      onMoveLeft: vi.fn(),
      onClose: vi.fn(),
      onUse: vi.fn(),
    };
    render(<RightHalfPane {...props} />);
    return props;
  }

  it("renders the session's terminal under a header naming it", () => {
    renderPane(true);
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-session", "6");
    expect(screen.getByTestId("terminal")).toHaveAttribute("data-active", "true");
    expect(screen.getByText("Dark mode palette")).toBeInTheDocument();
    expect(document.querySelector(".half-header.focused")).not.toBeNull();
  });

  it("moves the session left, closes the half, and reports a press as use", async () => {
    const user = userEvent.setup();
    const props = renderPane();
    expect(document.querySelector(".half-header.focused")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Move to the left half" }));
    expect(props.onMoveLeft).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close the right half" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
    fireEvent.pointerDown(screen.getByTestId("terminal"));
    expect(props.onUse).toHaveBeenCalled();
  });
});

describe("HalfHeader", () => {
  it("offers the move to the other half, or no button when the pane cannot move", async () => {
    const user = userEvent.setup();
    const onMove = vi.fn();
    const { rerender } = render(
      <HalfHeader
        side="left"
        title="login fix"
        projectName={null}
        onMove={onMove}
        focused={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Move to the right half" }));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Move to the right half" })).toHaveTextContent(
      "To right",
    );
    rerender(<HalfHeader side="left" title="Git" projectName={null} onMove={null} focused />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("HalfHeader rename and pane menu", () => {
  it("renames in place from the pane menu, and commits on Enter", async () => {
    const user = userEvent.setup();
    const onRenameCommit = vi.fn();
    render(
      <HalfHeader
        side="right"
        title="Dark mode palette"
        projectName={null}
        onMove={null}
        focused={false}
        renderActions={(startRename) => (
          <button type="button" onClick={startRename}>
            Pane menu
          </button>
        )}
        onRenameCommit={onRenameCommit}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pane menu" }));
    const input = screen.getByRole("textbox", { name: "Pane name" });
    expect(input).toHaveValue("Dark mode palette");
    await user.clear(input);
    await user.type(input, "Palette{Enter}");
    expect(onRenameCommit).toHaveBeenCalledWith("Palette");
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("drops a rename on Escape, and an unchanged or empty name", async () => {
    const user = userEvent.setup();
    const onRenameCommit = vi.fn();
    render(
      <HalfHeader
        side="left"
        title="login"
        projectName={null}
        onMove={null}
        focused={false}
        renderActions={(startRename) => (
          <button type="button" onClick={startRename}>
            Pane menu
          </button>
        )}
        onRenameCommit={onRenameCommit}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Pane menu" }));
    await user.type(screen.getByRole("textbox"), "x{Escape}");
    await user.click(screen.getByRole("button", { name: "Pane menu" }));
    await user.keyboard("{Enter}");
    await user.click(screen.getByRole("button", { name: "Pane menu" }));
    await user.clear(screen.getByRole("textbox"));
    await user.keyboard("{Enter}");
    expect(onRenameCommit).not.toHaveBeenCalled();
  });
});

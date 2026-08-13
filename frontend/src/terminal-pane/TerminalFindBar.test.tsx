// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { TerminalFindBar } from "./TerminalFindBar.js";

function renderBar(overrides: Partial<Parameters<typeof TerminalFindBar>[0]> = {}) {
  const props = {
    findQuery: "",
    onFindQueryChange: vi.fn(),
    matchState: null,
    findInputRef: createRef<HTMLInputElement>(),
    onRunSearch: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<TerminalFindBar {...props} />);
  return props;
}

describe("TerminalFindBar", () => {
  it("renders the query input and match count", () => {
    renderBar({ findQuery: "foo", matchState: { index: 1, count: 3 } });
    expect(screen.getByLabelText("Find in scrollback")).toHaveValue("foo");
    expect(screen.getByText("2/3")).toBeInTheDocument();
  });

  it("calls onFindQueryChange as the user types", async () => {
    const props = renderBar();
    await userEvent.type(screen.getByLabelText("Find in scrollback"), "x");
    expect(props.onFindQueryChange).toHaveBeenCalledWith("x");
  });

  it("Enter runs a forward search, Shift+Enter runs a backward search", async () => {
    const props = renderBar({ findQuery: "abc" });
    const input = screen.getByLabelText("Find in scrollback");
    await userEvent.type(input, "{Enter}");
    expect(props.onRunSearch).toHaveBeenLastCalledWith("next");
    await userEvent.type(input, "{Shift>}{Enter}{/Shift}");
    expect(props.onRunSearch).toHaveBeenLastCalledWith("previous");
  });

  it("Escape closes the bar", async () => {
    const props = renderBar();
    await userEvent.type(screen.getByLabelText("Find in scrollback"), "{Escape}");
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("previous/next buttons are disabled without a query and call onRunSearch when enabled", async () => {
    const props = renderBar({ findQuery: "abc" });
    await userEvent.click(screen.getByTitle("Next match (Enter)"));
    expect(props.onRunSearch).toHaveBeenCalledWith("next");
    await userEvent.click(screen.getByTitle("Previous match (Shift+Enter)"));
    expect(props.onRunSearch).toHaveBeenCalledWith("previous");
  });

  it("disables the nav buttons when the query is empty", () => {
    renderBar({ findQuery: "" });
    expect(screen.getByTitle("Next match (Enter)")).toBeDisabled();
    expect(screen.getByTitle("Previous match (Shift+Enter)")).toBeDisabled();
  });

  it("close button calls onClose", async () => {
    const props = renderBar();
    await userEvent.click(screen.getByTitle("Close (Esc)"));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

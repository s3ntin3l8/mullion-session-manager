// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Spinner } from "./Spinner.js";

// PR 25 (frontend refactor plan) — replaces the hand-rolled
// `<SpinnerIcon size={22} className="terminal-status-spinner connecting|
// reconnecting" />` repeated at the spinner call sites (BrowserPane.tsx,
// panels/registry.tsx, TerminalPane.tsx x2; Settings' fallback moved to
// the skeleton in issue #1885). `.terminal-status-spinner` itself is
// deliberately left unrenamed — see this component's own header comment.
describe("ui/Spinner", () => {
  it("defaults to the connecting variant at size 22", () => {
    const { container } = render(<Spinner />);
    const svg = container.querySelector("svg");
    expect(svg).toHaveClass("terminal-status-spinner", "connecting");
    expect(svg).toHaveAttribute("width", "22");
    expect(svg).toHaveAttribute("height", "22");
  });

  it("renders the reconnecting variant", () => {
    const { container } = render(<Spinner variant="reconnecting" />);
    expect(container.querySelector("svg")).toHaveClass("terminal-status-spinner", "reconnecting");
  });

  it("accepts a custom size", () => {
    const { container } = render(<Spinner size={13} />);
    expect(container.querySelector("svg")).toHaveAttribute("width", "13");
  });
});

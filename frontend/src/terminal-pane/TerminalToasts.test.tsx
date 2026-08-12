// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminalToasts } from "./TerminalToasts.js";

describe("TerminalToasts", () => {
  it("renders nothing when idle and not copied", () => {
    const { container } = render(
      <TerminalToasts copied={false} copyToastKey={0} uploadState="idle" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the copy toast when copied", () => {
    render(<TerminalToasts copied copyToastKey={0} uploadState="idle" />);
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("renders an uploading toast", () => {
    render(<TerminalToasts copied={false} copyToastKey={0} uploadState="uploading" />);
    expect(screen.getByText("Uploading image…")).toBeInTheDocument();
  });

  it("renders an error toast with the error class", () => {
    render(<TerminalToasts copied={false} copyToastKey={0} uploadState="error" />);
    const toast = screen.getByText("Image upload failed");
    expect(toast).toHaveClass("error");
  });

  it("both toasts can be shown at once", () => {
    render(<TerminalToasts copied copyToastKey={1} uploadState="uploading" />);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Uploading image…")).toBeInTheDocument();
  });
});

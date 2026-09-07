// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminalToasts } from "./TerminalToasts.js";

describe("TerminalToasts", () => {
  it("renders nothing when idle, not copied, and not too small", () => {
    const { container } = render(
      <TerminalToasts copied={false} copyToastKey={0} uploadState="idle" paneTooSmall={false} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the copy toast when copied", () => {
    render(<TerminalToasts copied copyToastKey={0} uploadState="idle" paneTooSmall={false} />);
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("renders an uploading toast", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        uploadState="uploading"
        paneTooSmall={false}
      />,
    );
    expect(screen.getByText("Uploading image…")).toBeInTheDocument();
  });

  it("renders an error toast with the error class", () => {
    render(
      <TerminalToasts copied={false} copyToastKey={0} uploadState="error" paneTooSmall={false} />,
    );
    const toast = screen.getByText("Image upload failed");
    expect(toast).toHaveClass("error");
  });

  it("both toasts can be shown at once", () => {
    render(<TerminalToasts copied copyToastKey={1} uploadState="uploading" paneTooSmall={false} />);
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Uploading image…")).toBeInTheDocument();
  });

  // Issue: small panes/floating windows ignoring input — a standing
  // condition (see TerminalToasts.tsx's own paneTooSmall doc comment),
  // unlike the transient copy/upload toasts above, so it's exercised
  // independently rather than folded into one of those cases.
  it("renders the too-small hint, and it can coexist with the other toasts", () => {
    render(<TerminalToasts copied copyToastKey={0} uploadState="uploading" paneTooSmall />);
    expect(screen.getByText("Pane too small")).toBeInTheDocument();
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Uploading image…")).toBeInTheDocument();
  });

  it("does not render the too-small hint when the pane fits", () => {
    render(
      <TerminalToasts copied={false} copyToastKey={0} uploadState="idle" paneTooSmall={false} />,
    );
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  it("renders a voice error toast, styled the same as an upload error", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
        voiceError="Microphone access denied — allow it in your browser's site settings."
      />,
    );
    const toast = screen.getByText(/microphone access denied/i);
    expect(toast).toHaveClass("error");
  });

  it("renders nothing extra when voiceError is null/undefined", () => {
    const { container } = render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
        voiceError={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

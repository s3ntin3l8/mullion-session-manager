// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminalToasts } from "./TerminalToasts.js";

describe("TerminalToasts", () => {
  // The component renders a permanent live region (the toasts come and go
  // INSIDE it — a live region only announces content that changes inside
  // it, so a region inserted together with its content is not reliably
  // announced). So "nothing to show" means "no toast element", not "no
  // element at all".
  const noToasts = (container: HTMLElement) =>
    expect(
      container.querySelector(
        ".terminal-copy-indicator, .terminal-upload-indicator, .terminal-too-small-indicator",
      ),
    ).toBeNull();

  it("renders no toast when idle, not copied, and not too small", () => {
    const { container } = render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
      />,
    );
    noToasts(container);
  });

  it("renders the copy toast when copied", () => {
    render(
      <TerminalToasts
        copied
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
      />,
    );
    expect(screen.getByText("Copied")).toBeInTheDocument();
  });

  it("renders a copy-failed toast with the error class", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage="Copy failed"
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
      />,
    );
    const toast = screen.getByText("Copy failed");
    expect(toast).toHaveClass("error");
  });

  it("does not render the copy-failed toast when a copy succeeded", () => {
    render(
      <TerminalToasts
        copied
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
      />,
    );
    expect(screen.queryByText("Copy failed")).not.toBeInTheDocument();
  });

  it("renders an uploading toast", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="uploading"
        paneTooSmall={false}
      />,
    );
    expect(screen.getByText("Uploading…")).toBeInTheDocument();
  });

  it("renders an error toast with the error class", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="error"
        paneTooSmall={false}
      />,
    );
    const toast = screen.getByText("Upload failed");
    expect(toast).toHaveClass("error");
  });

  it("both toasts can be shown at once", () => {
    render(
      <TerminalToasts
        copied
        copyToastKey={1}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="uploading"
        paneTooSmall={false}
      />,
    );
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Uploading…")).toBeInTheDocument();
  });

  // Issue: small panes/floating windows ignoring input — a standing
  // condition (see TerminalToasts.tsx's own paneTooSmall doc comment),
  // unlike the transient copy/upload toasts above, so it's exercised
  // independently rather than folded into one of those cases.
  it("renders the too-small hint, and it can coexist with the other toasts", () => {
    render(
      <TerminalToasts
        copied
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="uploading"
        paneTooSmall
      />,
    );
    expect(screen.getByText("Pane too small")).toBeInTheDocument();
    expect(screen.getByText("Copied")).toBeInTheDocument();
    expect(screen.getByText("Uploading…")).toBeInTheDocument();
  });

  it("does not render the too-small hint when the pane fits", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
      />,
    );
    expect(screen.queryByText("Pane too small")).not.toBeInTheDocument();
  });

  it("renders a voice error toast, styled the same as an upload error", () => {
    render(
      <TerminalToasts
        copied={false}
        copyToastKey={0}
        copyFailedMessage={null}
        copyFailedToastKey={0}
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
        copyFailedMessage={null}
        copyFailedToastKey={0}
        uploadState="idle"
        paneTooSmall={false}
        voiceError={null}
      />,
    );
    noToasts(container);
  });
});

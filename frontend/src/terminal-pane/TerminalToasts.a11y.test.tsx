// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TerminalToasts } from "./TerminalToasts.js";

// The terminal toasts were silent to assistive technology.
//
// "Copied" after a clipboard write, "Upload failed", a rejected copy, a
// voice error — none of them were announced, so a screen-reader user had no
// idea the copy had landed, or that it had failed.
//
// The mechanism is a PERMANENT live region: a live region only announces
// content that CHANGES inside it, so a region inserted into the DOM
// together with its content is not reliably announced. The wrapper is
// therefore always mounted and the toasts come and go inside it.

function renderToasts(overrides: Partial<React.ComponentProps<typeof TerminalToasts>> = {}) {
  return render(
    <TerminalToasts
      copied={false}
      copyToastKey={0}
      copyFailedMessage={null}
      copyFailedToastKey={0}
      uploadState="idle"
      paneTooSmall={false}
      {...overrides}
    />,
  );
}

describe("TerminalToasts — live region", () => {
  it("renders a persistent polite live region", () => {
    const { container } = renderToasts();
    const region = container.querySelector(".terminal-toasts");
    expect(region).not.toBeNull();
    expect(region).toHaveAttribute("role", "status");
    expect(region).toHaveAttribute("aria-live", "polite");
  });

  it("keeps the live region mounted when there is nothing to show", () => {
    // The region has to EXIST before the content changes — that is the whole
    // point of it being permanent rather than appearing with each toast.
    const { container } = renderToasts();
    expect(container.querySelector(".terminal-toasts")).not.toBeNull();
    expect(container.querySelector(".terminal-copy-indicator")).toBeNull();
  });

  it("announces the copy toast", () => {
    renderToasts({ copied: true });
    const toast = screen.getByText("Copied");
    // The toast is inside the polite region, so it is announced when it
    // appears — it does not need its own role.
    expect(toast.closest('[role="status"]')).not.toBeNull();
  });

  it("raises a failed copy as an alert", () => {
    renderToasts({ copyFailedMessage: "Clipboard unavailable" });
    const toast = screen.getByText("Clipboard unavailable");
    expect(toast).toHaveAttribute("role", "alert");
  });

  it("raises a failed upload as an alert", () => {
    renderToasts({ uploadState: "error" });
    expect(screen.getByText("Upload failed")).toHaveAttribute("role", "alert");
  });

  it("raises a voice error as an alert", () => {
    renderToasts({ voiceError: "Microphone access denied" });
    expect(screen.getByText("Microphone access denied")).toHaveAttribute("role", "alert");
  });

  it("raises the too-small pane notice as an alert", () => {
    renderToasts({ paneTooSmall: true });
    expect(screen.getByText("Pane too small")).toHaveAttribute("role", "alert");
  });

  it("leaves an in-flight upload in the polite region", () => {
    renderToasts({ uploadState: "uploading" });
    const toast = screen.getByText("Uploading…");
    expect(toast).not.toHaveAttribute("role", "alert");
    expect(toast.closest('[role="status"]')).not.toBeNull();
  });
});

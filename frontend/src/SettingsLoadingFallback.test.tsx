// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SettingsLoadingFallback } from "./SettingsLoadingFallback.js";

// Issue #1885 — the Settings chunk used to fall back to a centered spinner
// in an empty modal. The shell now keeps the modal's shape (rail + section
// body) and does not print the word "Loading…".
describe("SettingsLoadingFallback", () => {
  it("renders a skeleton instead of the word Loading… while the chunk loads", async () => {
    const onClose = vi.fn();
    const { container } = render(<SettingsLoadingFallback onClose={onClose} />);

    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-busy", "true");
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument();
    expect(container.querySelector(".terminal-status-spinner")).not.toBeInTheDocument();

    const bones = container.querySelectorAll(".ui-skeleton");
    expect(bones.length).toBeGreaterThan(0);
    for (const bone of bones) {
      expect(bone).toHaveAttribute("aria-hidden", "true");
    }
    // The announcement is clipped off screen, not a second visible label.
    const status = screen.getByRole("status");
    expect(status).toHaveClass("visually-hidden");
    expect(status).toHaveTextContent("Loading settings");

    await userEvent.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

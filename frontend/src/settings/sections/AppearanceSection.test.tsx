// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppearanceSection } from "./AppearanceSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";

describe("AppearanceSection — balance panes after dragging", () => {
  it("reflects the setting and writes the flipped value back", async () => {
    const updateSettings = vi.fn();
    useDashboardStore.setState({
      settings: { ...DEFAULT_SETTINGS, balancePanesOnDrop: true },
      updateSettings,
    } as never);
    render(<AppearanceSection />);

    const toggle = screen.getByRole("button", { name: /balance panes after dragging/i });
    expect(toggle).toHaveAttribute("aria-pressed", "true");

    await userEvent.setup().click(toggle);

    expect(updateSettings).toHaveBeenCalledWith({ balancePanesOnDrop: false });
  });
});

// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { StrictMode } from "react";
import { GitPanelRedirect } from "./GitPanelRedirect.js";

describe("GitPanelRedirect", () => {
  it("calls onOpen once on mount, even under StrictMode's double effect", () => {
    const onOpen = vi.fn();
    render(
      <StrictMode>
        <GitPanelRedirect onOpen={onOpen} />
      </StrictMode>,
    );
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("offers a manual 'Open Source Control' fallback", async () => {
    const onOpen = vi.fn();
    render(<GitPanelRedirect onOpen={onOpen} />);
    onOpen.mockClear();
    await userEvent.click(screen.getByRole("button", { name: /open source control/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

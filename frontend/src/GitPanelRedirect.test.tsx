// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { GitPanelRedirect } from "./GitPanelRedirect.js";

describe("GitPanelRedirect", () => {
  it("offers an 'Open Source Control' button that calls onOpen", async () => {
    const onOpen = vi.fn();
    render(<GitPanelRedirect onOpen={onOpen} />);
    expect(onOpen).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /open source control/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});

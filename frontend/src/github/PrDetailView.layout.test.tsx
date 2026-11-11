// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PrDetailView } from "./PrDetailView.js";
import { PR, stub } from "./prDetailTestKit.js";

// The detail layout of epic #2922 (option B): state blocks are cards, long lists
// are rule sections, and the view root owns the shared inset.
describe("PrDetailView layout", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("boxes the description as a card and keeps Changes a rule section", async () => {
    stub(PR);
    const { container } = render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);
    const description = await screen.findByRole("button", { name: /^Description/ });
    expect(container.querySelector(".pr-detail")).toHaveClass("sb-detail");
    expect(description.closest("section")).toHaveClass("sb-sec--card");
    expect(screen.getByRole("button", { name: /^Changes/ }).closest("section")).not.toHaveClass(
      "sb-sec--card",
    );
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PrDetailView } from "./PrDetailView.js";
import { PR, stub } from "./prDetailTestKit.js";

// The PR timeline: each review/comment is a card, newest first, with only the
// newest open. (The fixture has bob's review on 01-02 and carol's comment on 01-03.)
describe("PrDetailView's conversation timeline", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("lists the newest first and opens only that one; the rest unfold on click", async () => {
    const user = userEvent.setup();
    stub(PR);
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);

    const carol = await screen.findByRole("button", { name: /carol/ });
    const bob = screen.getByRole("button", { name: /bob.*approved/i });
    // Newest first: carol's comment sits above bob's older review.
    expect(carol.compareDocumentPosition(bob) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(carol).toHaveAttribute("aria-expanded", "true");
    expect(bob).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("nice")).toBeInTheDocument();
    expect(screen.queryByText("lgtm")).toBeNull();

    await user.click(bob);
    expect(screen.getByText("lgtm")).toBeInTheDocument();
    // Opening one does not close the other.
    expect(screen.getByText("nice")).toBeInTheDocument();
  });

  it("says which round a folded review belongs to", async () => {
    stub({
      ...PR,
      reviews: [
        {
          author: "mullion-reviewer",
          state: "CHANGES_REQUESTED",
          bodyHtml: "<h2>Round 3 (re-review after suggestions)</h2><p>fix it</p>",
          createdAt: "2026-01-01T00:00:00Z",
        },
      ],
    });
    render(<PrDetailView projectId={1} number={12} onBack={vi.fn()} />);

    const review = await screen.findByRole("button", { name: /mullion-reviewer/ });
    expect(review).toHaveTextContent("Changes requested");
    expect(review).toHaveTextContent("Round 3 (re-review after suggestions)");
    // Older than carol's comment, so folded: the body is not in the page yet.
    expect(review).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("fix it")).toBeNull();
  });
});

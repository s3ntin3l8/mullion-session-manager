// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommentCard } from "./CommentCard.js";
import { roundLabelFromHtml } from "../lib/reviewRounds.js";

const AT = "2026-01-02T00:00:00Z";

describe("roundLabelFromHtml", () => {
  it("reads the Round heading a review opens with", () => {
    expect(roundLabelFromHtml("<h2>Round 4 (re-review after suggestions)</h2><p>x</p>")).toBe(
      "Round 4 (re-review after suggestions)",
    );
    expect(roundLabelFromHtml('<h2 id="r1">Round 1</h2>')).toBe("Round 1");
    expect(roundLabelFromHtml("<h3>Round 2 &amp; a half</h3>")).toBe("Round 2 & a half");
  });

  it("is null for a comment that is not a review round", () => {
    expect(roundLabelFromHtml("<p>Round 3 of drinks</p>")).toBeNull();
    expect(roundLabelFromHtml("<h2>Verdict</h2>")).toBeNull();
    expect(roundLabelFromHtml("")).toBeNull();
  });
});

describe("CommentCard", () => {
  it("folds the body away behind its header, which says who, what and when", async () => {
    const user = userEvent.setup();
    render(
      <CommentCard
        author="mullion-reviewer"
        at={AT}
        bodyHtml="<h2>Round 2</h2><p>looks wrong</p>"
        state={{ label: "Changes requested", tone: "danger" }}
        defaultOpen={false}
      />,
    );
    const header = screen.getByRole("button", { name: /mullion-reviewer/ });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(header).toHaveTextContent("Changes requested");
    // The round shows on the folded card, so it can be told apart from the others.
    expect(header).toHaveTextContent("Round 2");
    expect(screen.queryByText("looks wrong")).toBeNull();

    await user.click(header);
    expect(header).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("looks wrong")).toBeInTheDocument();
    expect(header.getAttribute("aria-controls")).toBe(
      screen.getByText("looks wrong").closest(".gh-card-b")!.id,
    );

    await user.click(header);
    expect(screen.queryByText("looks wrong")).toBeNull();
  });

  it("starts open when asked to, and names an author-less comment", () => {
    render(<CommentCard author={null} at={AT} bodyHtml="<p>hello</p>" defaultOpen />);
    expect(screen.getByText("hello")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /unknown/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  });
});

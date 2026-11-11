// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import kitCss from "../styles/sidebar-kit.css?raw";
import { IssueDetailView } from "./IssuesView.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { useDashboardStore } from "../store/index.js";

// Epic #2922: the `.sb-detail` root owns the inline inset, so every direct child that is
// not a section, a card or the header must be named in the `.sb-detail > …` inset rule,
// or it renders flush at 0px in the right sidebar (the comment box did once).
const DETAIL = {
  number: 7,
  title: "Crash on start",
  htmlUrl: "https://github.com/a/b/issues/7",
  author: "x",
  labels: [{ name: "bug", color: "d73a4a" }],
  assignees: ["bob"],
  commentCount: 0,
  milestone: "v1",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  taskStatus: null,
  writeIdentity: { kind: "user", login: "octocat" },
  state: "open",
  bodyHtml: "<p>body</p>",
  comments: [],
};

const insetRule = () => {
  const m = /([^{}]*\.sb-detail > [^{}]*)\{\s*padding-inline: var\(--sb-inset\);/.exec(kitCss);
  return m?.[1] ?? "";
};

describe("issue detail inset", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("insets every bare direct child of the .sb-detail root", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, DETAIL))),
    );
    useDashboardStore.setState({ tasks: [], sessions: [] });
    const { container } = render(<IssueDetailView projectId={1} number={7} onBack={vi.fn()} />);
    await screen.findByText("body");
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveClass("sb-detail");
    const rule = insetRule();
    expect(rule).not.toBe("");
    // The sticky header, sections and cards draw their own edge.
    const bare = Array.from(root.children).filter((el) => !el.matches("section, .pr-card, .sb-vh"));
    expect(bare.length).toBeGreaterThan(0);
    for (const el of bare) {
      const covered = rule
        .split(",")
        .map((sel) => sel.trim().replace(/^\.sb-detail > /, ""))
        .some((sel) => sel !== "" && el.matches(sel));
      expect(
        covered,
        `${el.tagName}.${el.className} is a bare .sb-detail child with no inset`,
      ).toBe(true);
    }
  });
});

// @vitest-environment jsdom
// Issue #990 — render coverage complementing lib/markdown.test.ts's pure
// parser tests.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "./Markdown.js";

describe("ui/Markdown", () => {
  it("passes through the className onto the outer wrapper", () => {
    const { container } = render(<Markdown text="hello" className="task-detail-review-findings" />);
    expect(container.querySelector(".task-detail-review-findings")).not.toBeNull();
  });

  it("renders ## and ### as h2/h3", () => {
    render(<Markdown text={"## Round 1\n\n### Critical\n- None"} />);
    expect(screen.getByRole("heading", { level: 2, name: "Round 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Critical" })).toBeInTheDocument();
  });

  it("groups consecutive bullets into one list", () => {
    const { container } = render(<Markdown text={"- one\n- two\n- three"} />);
    const lists = container.querySelectorAll("ul");
    expect(lists).toHaveLength(1);
    expect(lists[0]?.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders **bold** as <strong> and inline `code` as <code>", () => {
    render(<Markdown text={"before **bold** and `code` after"} />);
    expect(screen.getByText("bold", { selector: "strong" })).toBeInTheDocument();
    expect(screen.getByText("code", { selector: "code" })).toBeInTheDocument();
  });

  it("renders a two-round stacked value without losing either round's content", () => {
    const text = [
      "## Round 1",
      "",
      "The retry loop never backs off.",
      "",
      "## Round 2",
      "",
      "Fixed in the latest commit.",
    ].join("\n");
    render(<Markdown text={text} />);
    expect(screen.getByRole("heading", { level: 2, name: "Round 1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: "Round 2" })).toBeInTheDocument();
    expect(screen.getByText(/The retry loop never backs off\./)).toBeInTheDocument();
    expect(screen.getByText(/Fixed in the latest commit\./)).toBeInTheDocument();
  });

  it("degrades an unstructured value with a fenced code block to readable literal text, dropping nothing", () => {
    const text = [
      "Reproduces with:",
      "```ts",
      "const x = 1;",
      "```",
      "That's the bug -- treat this review as inconclusive.",
    ].join("\n");
    const { container } = render(<Markdown text={text} />);
    expect(container.textContent).toContain("Reproduces with:");
    expect(container.textContent).toContain("```ts");
    expect(container.textContent).toContain("const x = 1;");
    expect(container.textContent).toContain("```");
    expect(container.textContent).toContain("That's the bug -- treat this review as inconclusive.");
    // No heading/list elements manufactured out of the fence markers.
    expect(container.querySelector("h2, h3, ul")).toBeNull();
  });
});

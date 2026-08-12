// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  EmptyState,
  EmptyStateActions,
  EmptyStateBody,
  EmptyStateIcon,
  EmptyStateNote,
  EmptyStateTitle,
} from "./EmptyState.js";

// PR 25 (frontend refactor plan) — `EmptyState`/`EmptyStateNote` back the
// `ui-empty-state*` class family that replaced Sidebar's `.empty-state*`
// and the borrowed `.github-panel-empty` (see styles.css's own comments at
// those selectors, and each component's header comment here).
describe("ui/EmptyState", () => {
  it("renders the rich card container with the ui-empty-state class", () => {
    render(
      <EmptyState>
        <EmptyStateTitle>Title text</EmptyStateTitle>
        <EmptyStateBody>Body text</EmptyStateBody>
      </EmptyState>,
    );
    expect(screen.getByText("Title text").closest(".ui-empty-state")).toBeInTheDocument();
    expect(screen.getByText("Title text")).toHaveClass("ui-empty-state-title");
    expect(screen.getByText("Body text")).toHaveClass("ui-empty-state-body");
  });

  it("merges a caller className onto the base container", () => {
    render(<EmptyState className="discover-empty">content</EmptyState>);
    const el = screen.getByText("content");
    expect(el).toHaveClass("ui-empty-state");
    expect(el).toHaveClass("discover-empty");
  });

  it("EmptyStateIcon applies the accent/neutral/warn variant class", () => {
    render(
      <EmptyStateIcon variant="warn">
        <span>icon</span>
      </EmptyStateIcon>,
    );
    expect(screen.getByText("icon").closest("span.ui-empty-state-icon")).toHaveClass("warn");
  });

  it("EmptyStateActions wraps children in the actions row", () => {
    render(
      <EmptyStateActions>
        <button>Go</button>
      </EmptyStateActions>,
    );
    expect(screen.getByText("Go").closest(".ui-empty-state-actions")).toBeInTheDocument();
  });

  it("EmptyStateNote renders the plain muted block, not the rich card", () => {
    render(<EmptyStateNote>Loading…</EmptyStateNote>);
    const el = screen.getByText("Loading…");
    expect(el).toHaveClass("ui-empty-state-note");
    expect(el).not.toHaveClass("ui-empty-state");
  });

  it("EmptyStateNote merges a caller className", () => {
    render(<EmptyStateNote className="tasks-panel-empty">No tasks yet.</EmptyStateNote>);
    const el = screen.getByText("No tasks yet.");
    expect(el).toHaveClass("ui-empty-state-note");
    expect(el).toHaveClass("tasks-panel-empty");
  });
});

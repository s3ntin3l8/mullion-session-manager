// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ErrorText } from "./ErrorText.js";

// PR 25 (frontend refactor plan) — replaces the hand-rolled
// `<div style={{ fontSize: 12, color: "var(--r)" }} role="alert">` pattern
// repeated at 17 call sites across 9 files (Settings sections + host/GitHub
// modals). See this component's own header comment for the full list.
describe("ui/ErrorText", () => {
  it("renders children inside a role=alert element with the shared error style", () => {
    render(<ErrorText>Something went wrong</ErrorText>);
    const el = screen.getByRole("alert");
    expect(el).toHaveTextContent("Something went wrong");
    expect(el).toHaveStyle({ fontSize: "12px", color: "var(--r)" });
  });

  it("merges per-site style overrides (e.g. marginTop, flex) without dropping the base style", () => {
    render(<ErrorText style={{ marginTop: 8 }}>Failed</ErrorText>);
    const el = screen.getByRole("alert");
    expect(el).toHaveStyle({ fontSize: "12px", color: "var(--r)", marginTop: "8px" });
  });

  it("passes through an optional className", () => {
    render(<ErrorText className="create-modal-field-hint">Failed</ErrorText>);
    expect(screen.getByRole("alert")).toHaveClass("create-modal-field-hint");
  });
});

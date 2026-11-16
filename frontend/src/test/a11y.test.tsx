// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { expectNameHasVisibleText, expectNoNestedInteractive } from "./a11y.js";

describe("expectNameHasVisibleText", () => {
  it("passes when the name holds the visible words in order", () => {
    render(
      <button aria-label="Tasks, 3 need you">
        <span aria-hidden="true">Tasks</span> <span aria-hidden="true">3</span>
      </button>,
    );
    expectNameHasVisibleText(screen.getByRole("button"));
  });

  it("fails on glued spans, a word only part of a name, and content naming checked", () => {
    const { unmount } = render(
      <button aria-label="Tasks, 3 need you">
        <span>Tasks</span>
        <span>3</span>
      </button>,
    );
    expect(() => expectNameHasVisibleText(screen.getByRole("button"))).toThrow();
    unmount();
    const second = render(
      <button aria-label="Workspace">
        <span aria-hidden="true">Work</span>
      </button>,
    );
    expect(() => expectNameHasVisibleText(screen.getByRole("button"))).toThrow();
    second.unmount();
    // Named by content, the hidden word drops out of the name but not the screen.
    render(
      <button>
        <span aria-hidden="true">Work</span>
        <span className="visually-hidden">space</span>
      </button>,
    );
    expect(() => expectNameHasVisibleText(screen.getByRole("button"))).toThrow();
  });

  it("has nothing to match on a control that shows no words", () => {
    render(
      <button aria-label="Dismiss">
        <span aria-hidden="true">×</span>
      </button>,
    );
    expectNameHasVisibleText(screen.getByRole("button"));
  });
});

describe("expectNoNestedInteractive", () => {
  it("fails on a control inside a control, passes on siblings", () => {
    const { container, unmount } = render(
      <div role="button" tabIndex={0}>
        <button>x</button>
      </div>,
    );
    expect(() => expectNoNestedInteractive(container)).toThrow();
    unmount();
    const ok = render(
      <div>
        <button>a</button>
        <button>b</button>
      </div>,
    );
    expectNoNestedInteractive(ok.container);
  });
});

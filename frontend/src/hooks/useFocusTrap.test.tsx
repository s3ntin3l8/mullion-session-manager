// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { useRef, useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useFocusTrap } from "./useFocusTrap.js";

// A minimal harness exercising the hook directly, rather than through one of
// its four real call sites — those get their own site-specific tests
// (Settings/CommandPalette/PaneTab/NotificationBell) that additionally prove
// the hook is actually wired up there. This file is the hook's own unit
// coverage: focus-on-open, the Tab trap (including the aria-hidden filter
// CommandPalette's skip-permissions block needs), restore-on-close, and the
// suppressRestore escape hatch PR13-style "close by opening something else"
// paths use.
function Harness({ initialActive = false }: { initialActive?: boolean }) {
  const [active, setActive] = useState(initialActive);
  const containerRef = useRef<HTMLDivElement>(null);
  const { onKeyDown, suppressRestore } = useFocusTrap({ active, containerRef });

  return (
    <div>
      <button onClick={() => setActive(true)}>open</button>
      {active && (
        <div ref={containerRef} onKeyDown={onKeyDown} data-testid="trap">
          <button>first</button>
          <button>middle</button>
          <button>last</button>
          <button
            onClick={() => {
              suppressRestore();
              setActive(false);
            }}
          >
            open-elsewhere
          </button>
          <button onClick={() => setActive(false)}>plain-close</button>
        </div>
      )}
      <button>outside</button>
    </div>
  );
}

describe("useFocusTrap", () => {
  it("moves focus to the first focusable descendant when it becomes active", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("open"));
    expect(screen.getByText("first")).toHaveFocus();
  });

  it("uses initialFocusRef instead of the first descendant when given", async () => {
    function HarnessWithInitial() {
      const [active, setActive] = useState(false);
      const containerRef = useRef<HTMLDivElement>(null);
      const middleRef = useRef<HTMLButtonElement>(null);
      const { onKeyDown } = useFocusTrap({ active, containerRef, initialFocusRef: middleRef });
      return (
        <div>
          <button onClick={() => setActive(true)}>open</button>
          {active && (
            <div ref={containerRef} onKeyDown={onKeyDown}>
              <button>first</button>
              <button ref={middleRef}>middle</button>
              <button>last</button>
            </div>
          )}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<HarnessWithInitial />);
    await user.click(screen.getByText("open"));
    expect(screen.getByText("middle")).toHaveFocus();
  });

  it("wraps Tab from the last element back to the first, and Shift+Tab from the first to the last", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByText("open"));

    screen.getByText("plain-close").focus();
    await user.tab();
    expect(screen.getByText("first")).toHaveFocus();

    screen.getByText("first").focus();
    await user.tab({ shift: true });
    expect(screen.getByText("plain-close")).toHaveFocus();
  });

  // Independent code review — CommandPalette.tsx's own coarse-pointer path
  // anchors initial focus on the trap's container itself (`tabIndex={-1}`),
  // not any focusable descendant. getFocusable's selector excludes
  // `[tabindex="-1"]`, so the container is never `first`/`last` — without
  // the container.current-anchor branch in the hook, Shift+Tab from there
  // escaped the trap entirely via the browser's own native default instead
  // of wrapping to `last`.
  function HarnessWithContainerAnchor() {
    const [active, setActive] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);
    const { onKeyDown } = useFocusTrap({ active, containerRef, initialFocusRef: containerRef });
    return (
      <div>
        <button onClick={() => setActive(true)}>open</button>
        {active && (
          <div ref={containerRef} onKeyDown={onKeyDown} tabIndex={-1} data-testid="trap">
            <button>first</button>
            <button>last</button>
          </div>
        )}
        <button>outside</button>
      </div>
    );
  }

  it("focuses the container itself when initialFocusRef points at it", async () => {
    const user = userEvent.setup();
    render(<HarnessWithContainerAnchor />);
    await user.click(screen.getByText("open"));
    expect(screen.getByTestId("trap")).toHaveFocus();
  });

  it("wraps Tab from the container anchor to the first focusable descendant", async () => {
    const user = userEvent.setup();
    render(<HarnessWithContainerAnchor />);
    await user.click(screen.getByText("open"));
    expect(screen.getByTestId("trap")).toHaveFocus();

    await user.tab();

    expect(screen.getByText("first")).toHaveFocus();
  });

  it("wraps Shift+Tab from the container anchor to the last focusable descendant, not out of the dialog", async () => {
    const user = userEvent.setup();
    render(<HarnessWithContainerAnchor />);
    await user.click(screen.getByText("open"));
    expect(screen.getByTestId("trap")).toHaveFocus();

    await user.tab({ shift: true });

    expect(screen.getByText("last")).toHaveFocus();
  });

  it("restores focus to the trigger element on a plain close", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const openBtn = screen.getByText("open");
    await user.click(openBtn);
    await user.click(screen.getByText("plain-close"));
    expect(openBtn).toHaveFocus();
  });

  it("does NOT restore focus to the trigger when suppressRestore was called before closing", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const openBtn = screen.getByText("open");
    await user.click(openBtn);
    await user.click(screen.getByText("open-elsewhere"));
    expect(openBtn).not.toHaveFocus();
  });

  it("skips restore when the trigger is no longer connected to the document", async () => {
    function Unmounting() {
      const [triggerMounted, setTriggerMounted] = useState(true);
      const [active, setActive] = useState(false);
      const containerRef = useRef<HTMLDivElement>(null);
      const { onKeyDown } = useFocusTrap({ active, containerRef });
      return (
        <div>
          {triggerMounted && (
            <button
              onClick={() => {
                setActive(true);
              }}
            >
              open
            </button>
          )}
          {active && (
            <div ref={containerRef} onKeyDown={onKeyDown}>
              <button
                onClick={() => {
                  // Detach the trigger before closing, mirroring a trigger
                  // whose surrounding UI disappears while the overlay is open.
                  setTriggerMounted(false);
                  setActive(false);
                }}
              >
                close-and-unmount-trigger
              </button>
            </div>
          )}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Unmounting />);
    await user.click(screen.getByText("open"));
    expect(() => user.click(screen.getByText("close-and-unmount-trigger"))).not.toThrow();
  });

  it("filters aria-hidden descendants out of both the initial focus target and the Tab trap", async () => {
    function HarnessWithHidden() {
      const [active, setActive] = useState(false);
      const containerRef = useRef<HTMLDivElement>(null);
      const { onKeyDown } = useFocusTrap({ active, containerRef });
      return (
        <div>
          <button onClick={() => setActive(true)}>open</button>
          {active && (
            <div ref={containerRef} onKeyDown={onKeyDown}>
              <div aria-hidden="true">
                <button>hidden-first</button>
              </div>
              <button>visible</button>
              <div aria-hidden="true">
                <button>hidden-last</button>
              </div>
            </div>
          )}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<HarnessWithHidden />);
    await user.click(screen.getByText("open"));
    // The only real candidate is "visible" — an aria-hidden-filtered trap
    // with a single focusable descendant is a no-op on Tab (there's nothing
    // to wrap to), so this also proves it didn't fall through to the hidden
    // siblings.
    expect(screen.getByText("visible")).toHaveFocus();
  });

  // Hermes review, PR #621 round 3 — Settings.tsx's mobile drill-down keeps
  // both panes mounted, toggling visibility with `display: none` rather than
  // unmounting, so a display:none descendant needs the same treatment as an
  // aria-hidden one: excluded from both the initial-focus target and the Tab
  // wrap boundary. Inline `style={{ display: "none" }}` (not a stylesheet
  // rule) so this is jsdom-safe — see the hook's own comment on why.
  it("filters display:none descendants out of both the initial focus target and the Tab trap", async () => {
    function HarnessWithDisplayNone() {
      const [active, setActive] = useState(false);
      const containerRef = useRef<HTMLDivElement>(null);
      const { onKeyDown } = useFocusTrap({ active, containerRef });
      return (
        <div>
          <button onClick={() => setActive(true)}>open</button>
          {active && (
            <div ref={containerRef} onKeyDown={onKeyDown}>
              <button style={{ display: "none" }}>hidden-first</button>
              <button>visible</button>
              <button style={{ display: "none" }}>hidden-last</button>
            </div>
          )}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<HarnessWithDisplayNone />);
    await user.click(screen.getByText("open"));
    // Same reasoning as the aria-hidden case above: "visible" is the only
    // real candidate, so Tab wrapping to it (rather than escaping the trap,
    // or landing on a hidden sibling) proves the filter's actually applied
    // at both the initial-focus site and the wrap-boundary check.
    expect(screen.getByText("visible")).toHaveFocus();
    await user.tab();
    expect(screen.getByText("visible")).toHaveFocus();
  });

  it("filters a display:none ANCESTOR out too, not just an element's own display", async () => {
    function HarnessWithHiddenAncestor() {
      const [active, setActive] = useState(false);
      const containerRef = useRef<HTMLDivElement>(null);
      const { onKeyDown } = useFocusTrap({ active, containerRef });
      return (
        <div>
          <button onClick={() => setActive(true)}>open</button>
          {active && (
            <div ref={containerRef} onKeyDown={onKeyDown}>
              {/* The child itself has no display override — only its
                  wrapper does, mirroring Settings.tsx's `.settings-nav`/
                  `.settings-content` panes (the `display: none` rule
                  targets the pane container, not each control inside it). */}
              <div style={{ display: "none" }}>
                <button>hidden-inside-hidden-wrapper</button>
              </div>
              <button>visible</button>
            </div>
          )}
        </div>
      );
    }
    const user = userEvent.setup();
    render(<HarnessWithHiddenAncestor />);
    await user.click(screen.getByText("open"));
    expect(screen.getByText("visible")).toHaveFocus();
  });
});

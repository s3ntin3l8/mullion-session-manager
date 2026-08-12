// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";

// P11 — the settings modal previously had none of UnifiedBoard.tsx's
// task-detail drawer's focus management: no role="dialog", no focus-in on
// open, no Tab trap, no focus-restore on close. Uses the shared
// useFocusTrap.ts hook (see that file's own doc comment for the extraction
// rationale) — this suite exercises the hook AS WIRED into Settings.tsx,
// not the hook's own mechanics (covered by useFocusTrap.test.tsx).

function focusableDescendants(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

describe("Settings modal — focus management (P11)", () => {
  beforeEach(() => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("has dialog semantics and moves focus into the modal on open", () => {
    const { container } = render(<Settings onClose={vi.fn()} />);
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    // First focusable descendant is the close button — it precedes the
    // search input in DOM order — same "first focusable, not something
    // hand-picked" default as UnifiedBoard.tsx's own drawer.
    const first = focusableDescendants(container.querySelector(".settings-modal")!)[0];
    expect(first).toHaveClass("settings-modal-close");
    expect(first).toHaveFocus();
  });

  it("restores focus to the trigger element on close", () => {
    render(
      <button
        onClick={() => {
          /* trigger for the focus-capture assertion below — the real
             open/close flow is App.tsx's own conditional mount */
        }}
      >
        open settings
      </button>,
    );
    const trigger = screen.getByText("open settings");
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<Settings onClose={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);

    // Mirrors App.tsx's `{settingsOpen && <Settings ... />}` — closing is a
    // full unmount, not a prop flip.
    unmount();
    expect(trigger).toHaveFocus();
  });

  it("traps Tab within the modal", async () => {
    const user = userEvent.setup();
    const { container } = render(<Settings onClose={vi.fn()} />);
    const dialog = container.querySelector(".settings-modal") as HTMLElement;
    const focusable = focusableDescendants(dialog);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });

  it("does not close on Escape via a local handler (App.tsx's global handler already covers it)", () => {
    // Settings.tsx deliberately does not wire its own Escape handler — see
    // that component's own comment. This pins that closing the modal
    // doesn't ALSO happen through some local mechanism that would
    // double-fire alongside App.tsx's window-level listener; the global
    // listener itself is covered by App.tsx's own tests.
    const onClose = vi.fn();
    const { container } = render(<Settings onClose={onClose} />);
    const dialog = container.querySelector(".settings-modal") as HTMLElement;
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});

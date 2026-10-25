// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CreateGroupModal } from "../CreateGroupModal.js";
import { CreateHostModal } from "../CreateHostModal.js";

// The seven hand-rolled dialogs.
//
// Each of these used to build its own backdrop + header + close button, with
// no `role="dialog"`, no `aria-modal`, no focus trap and no Escape-to-close:
// a screen reader announced them as a plain div, a keyboard user's focus
// stayed on the page behind, and Escape did nothing. The shared
// `ui/Modal.tsx` had all of that — the seven simply never used it.
//
// These tests pin the two halves of the fix: the runtime behaviour the
// shared Modal provides, and the structural fact that no dialog in the app
// hand-rolls its own shell any more.

/** The files that used to hand-roll a dialog shell. */
const MIGRATED_MODAL_FILES = [
  "../CreateProjectModal.tsx",
  "../CreateHostModal.tsx",
  "../CreateGroupModal.tsx",
  "../HostConfigModal.tsx",
  "../PairBridgeModal.tsx",
  "../GitHubDeviceFlowModal.tsx",
  "../SavedUrlModal.tsx",
] as const;

describe("migrated dialogs — dialog semantics", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("CreateGroupModal is a labelled modal dialog", () => {
    render(<CreateGroupModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("New workspace group");
  });

  it("CreateHostModal is a labelled modal dialog", () => {
    render(<CreateHostModal onClose={vi.fn()} onSave={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Add host");
  });

  it("gives the close button an accessible name", () => {
    render(<CreateGroupModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeInTheDocument();
  });

  it("moves focus into the dialog on open", () => {
    render(<CreateGroupModal onClose={vi.fn()} onCreate={vi.fn()} />);
    // The name field is the control the dialog exists to fill in, so it is
    // the initial focus — not the close button, which comes first in DOM
    // order and is what the focus trap would pick by default.
    expect(screen.getByRole("textbox", { name: /Workspace name/ })).toHaveFocus();
  });

  it("closes on Escape", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<CreateGroupModal onClose={onClose} onCreate={vi.fn()} />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("restores focus to the trigger on close", () => {
    render(<button>open group modal</button>);
    const trigger = screen.getByText("open group modal");
    trigger.focus();
    expect(trigger).toHaveFocus();

    const { unmount } = render(<CreateGroupModal onClose={vi.fn()} onCreate={vi.fn()} />);
    expect(document.activeElement).not.toBe(trigger);

    // Mirrors the call site's `{open && <CreateGroupModal … />}` — closing
    // is a full unmount, not a prop flip.
    unmount();
    expect(trigger).toHaveFocus();
  });

  it("traps Tab within the dialog", async () => {
    const user = userEvent.setup();
    const { container } = render(<CreateGroupModal onClose={vi.fn()} onCreate={vi.fn()} />);
    const dialog = container.querySelector(".create-modal") as HTMLElement;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [href], select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    );
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    await user.tab();
    expect(first).toHaveFocus();

    first.focus();
    await user.tab({ shift: true });
    expect(last).toHaveFocus();
  });
});

describe("migrated dialogs — no hand-rolled shells left", () => {
  it("every migrated dialog composes the shared Modal", async () => {
    // import.meta.glob (rather than node:fs) keeps this file within
    // tsconfig.app.json's browser-only type universe — see
    // pwaSplashScreens.test.ts for the same pattern.
    const sources = import.meta.glob("../*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    for (const file of MIGRATED_MODAL_FILES) {
      // The glob's keys are already relative to this file's directory
      // ("../CreateProjectModal.tsx"), which is exactly what
      // MIGRATED_MODAL_FILES holds — so the lookup is the key itself.
      const src = sources[file];
      expect(src, `${file} should exist`).toBeDefined();
      expect(src, `${file} should compose the shared Modal`).toMatch(/<Modal\b/);
      expect(src, `${file} should not hand-roll a backdrop`).not.toMatch(
        /className="create-modal-backdrop"/,
      );
      expect(src, `${file} should not hand-roll a close button`).not.toMatch(
        /className="create-modal-close"/,
      );
    }
  });

  it("no migrated dialog declares its own dialog role", async () => {
    // The seven migrated dialogs must DELEGATE their dialog semantics to the
    // shared Modal rather than re-declaring them — a file that keeps its own
    // `role="dialog"` is a file that could easily keep its own (missing)
    // `aria-modal` too.
    const sources = import.meta.glob("../*.tsx", {
      eager: true,
      query: "?raw",
      import: "default",
    }) as Record<string, string>;

    const offenders: string[] = [];
    for (const file of MIGRATED_MODAL_FILES) {
      const src = sources[file];
      if (/role="dialog"/.test(src)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });
});

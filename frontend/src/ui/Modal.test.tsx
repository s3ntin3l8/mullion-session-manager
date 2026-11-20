// @vitest-environment jsdom
import { useRef } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Modal } from "./Modal.js";

// PR 24 pilot — `Modal`'s own unit coverage, independent of any one of the
// seven `create-modal-*` dialogs it's meant to eventually back (only
// `PromoteDialog` is migrated so far; that migration's own test file also
// asserts these same behaviors are actually wired up end-to-end through a
// real dialog). This file exercises the component in isolation: the
// backdrop/stopPropagation/close-button shape every one of the seven already
// had, plus the new role/aria-modal/Escape/focus-trap behavior this PR adds.
describe("ui/Modal", () => {
  it("renders icon, title, subtitle, children, and footer using the create-modal-* classes", () => {
    render(
      <Modal
        onClose={vi.fn()}
        icon={<span>icon</span>}
        title="Dialog title"
        subtitle="Subtitle text"
      >
        <p>body content</p>
      </Modal>,
    );

    expect(screen.getByText("icon").closest(".create-modal-icon")).toBeInTheDocument();
    expect(screen.getByText("Dialog title")).toHaveClass("create-modal-title");
    expect(screen.getByText("Subtitle text")).toHaveClass("create-modal-subtitle");
    expect(screen.getByText("body content").closest(".create-modal-body")).toBeInTheDocument();
    expect(document.querySelector(".create-modal-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".create-modal")).toBeInTheDocument();
    // No footer prop passed — the footer wrapper shouldn't render at all.
    expect(document.querySelector(".create-modal-footer")).not.toBeInTheDocument();
  });

  it("renders the footer only when a footer prop is provided", () => {
    render(
      <Modal onClose={vi.fn()} title="T" footer={<span>footer content</span>}>
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByText("footer content").closest(".create-modal-footer")).toBeInTheDocument();
  });

  it("exposes role=dialog, aria-modal=true, and defaults aria-label to a string title", () => {
    render(
      <Modal onClose={vi.fn()} title="My Dialog">
        <p>body</p>
      </Modal>,
    );
    const dialog = screen.getByRole("dialog", { name: "My Dialog" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
  });

  it("prefers an explicit ariaLabel over a string title", () => {
    render(
      <Modal onClose={vi.fn()} title="My Dialog" ariaLabel="Explicit label">
        <p>body</p>
      </Modal>,
    );
    expect(screen.getByRole("dialog", { name: "Explicit label" })).toBeInTheDocument();
  });

  it("calls onClose on backdrop click, but NOT when clicking inside the dialog", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal onClose={onClose} title="T">
        <button>inside</button>
      </Modal>,
    );

    await user.click(screen.getByText("inside"));
    expect(onClose).not.toHaveBeenCalled();

    await user.click(document.querySelector(".create-modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when the header close button is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal onClose={onClose} title="T">
        <p>body</p>
      </Modal>,
    );
    await user.click(document.querySelector(".create-modal-close")!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closeDisabled keeps the close button focusable but inert", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal onClose={onClose} closeDisabled title="T">
        <p>body</p>
      </Modal>,
    );
    const close = screen.getByRole("button", { name: "Close dialog" });
    // aria-disabled, not disabled: it stays the focus target inside the dialog.
    expect(close).toHaveAttribute("aria-disabled", "true");
    expect(close).not.toBeDisabled();
    close.focus();
    expect(close).toHaveFocus();
    await user.click(close);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("calls onClose on Escape", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <Modal onClose={onClose} title="T">
        <button>inside</button>
      </Modal>,
    );
    await screen.findByRole("dialog");
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("focuses the first focusable descendant on mount and traps Tab within the dialog", async () => {
    const user = userEvent.setup();
    render(
      <Modal onClose={vi.fn()} title="T">
        <button>first</button>
        <button>last</button>
      </Modal>,
    );

    // The header's close button precedes the body content in DOM order, so
    // it — not the body's own "first" button — is the actual first
    // focusable descendant `useFocusTrap`'s default targets.
    const closeBtn = document.querySelector<HTMLElement>(".create-modal-close")!;
    expect(closeBtn).toHaveFocus();

    screen.getByText("last").focus();
    await user.tab();
    expect(closeBtn).toHaveFocus();

    closeBtn.focus();
    await user.tab({ shift: true });
    expect(screen.getByText("last")).toHaveFocus();
  });

  it("honors an explicit initialFocusRef instead of the first descendant default", () => {
    function Harness() {
      const inputRef = useRef<HTMLInputElement>(null);
      return (
        <Modal onClose={vi.fn()} title="T" initialFocusRef={inputRef}>
          <button>first</button>
          <input ref={inputRef} placeholder="target" />
        </Modal>
      );
    }
    render(<Harness />);
    expect(screen.getByPlaceholderText("target")).toHaveFocus();
  });

  it("supports overriding backdropClassName/modalClassName for non-create-modal callers", () => {
    render(
      <Modal
        onClose={vi.fn()}
        title="T"
        backdropClassName="overlay-backdrop"
        modalClassName="saved-url-modal"
      >
        <p>body</p>
      </Modal>,
    );
    expect(document.querySelector(".overlay-backdrop")).toBeInTheDocument();
    expect(document.querySelector(".saved-url-modal")).toBeInTheDocument();
    expect(document.querySelector(".create-modal-backdrop")).not.toBeInTheDocument();
  });
});

// #3015 — Escape, the backdrop and the close button play the exit first.
describe("ui/Modal exit", () => {
  it("leaves the way it came before it asks the caller to close", async () => {
    const { installExitAnimations } = await import("../test/exitAnimations.js");
    const exits = installExitAnimations();
    try {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose} title="T">
          <p>body</p>
        </Modal>,
      );
      const backdrop = document.querySelector(".create-modal-backdrop") as HTMLElement;
      expect(backdrop).toHaveClass("motion-scrim");
      expect(document.querySelector(".create-modal")).toHaveClass("motion-dialog");
      expect(backdrop).toHaveAttribute("data-presence", "open");

      await user.click(screen.getByRole("button", { name: "Close dialog" }));
      expect(backdrop).toHaveAttribute("data-presence", "leaving");
      expect(onClose).not.toHaveBeenCalled();

      await exits.finishExits();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      exits.restore();
    }
  });

  it("closes at once while closeDisabled (the caller keeps it)", async () => {
    const { installExitAnimations } = await import("../test/exitAnimations.js");
    const exits = installExitAnimations();
    try {
      const user = userEvent.setup();
      const onClose = vi.fn();
      render(
        <Modal onClose={onClose} title="T" closeDisabled>
          <p>body</p>
        </Modal>,
      );
      await user.keyboard("{Escape}");
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(document.querySelector(".create-modal-backdrop")).toHaveAttribute(
        "data-presence",
        "open",
      );
    } finally {
      exits.restore();
    }
  });
});

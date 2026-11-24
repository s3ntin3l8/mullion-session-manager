// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Presence } from "./Presence.js";
import { Modal } from "./Modal.js";
import { CreateGroupModal } from "../CreateGroupModal.js";
import { installExitAnimations } from "../test/exitAnimations.js";
import type { ExitAnimations } from "../test/exitAnimations.js";

// #3037 — an overlay its parent mounts leaves on its exit when the PARENT
// closes it, not only from its own dismiss controls.

const backdrop = () => document.querySelector(".create-modal-backdrop");

// The usual call site: a trigger, and the dialog behind `<Presence>`.
function Harness({
  onCreate = () => Promise.resolve(),
}: {
  onCreate?: (name: string, color: string) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button onClick={() => setOpen(true)}>Open</button>
      <button onClick={() => setOpen(false)}>Parent close</button>
      <Presence when={open}>
        <CreateGroupModal onClose={() => setOpen(false)} onCreate={onCreate} />
      </Presence>
    </>
  );
}

describe("ui/Presence", () => {
  let exits: ExitAnimations;
  beforeEach(() => {
    exits = installExitAnimations();
  });
  afterEach(() => {
    exits.restore();
    vi.unstubAllGlobals();
  });

  it("plays the exit when a submit succeeds, without holding the submit back", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(() => Promise.resolve());
    render(<Harness onCreate={onCreate} />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(backdrop()).toHaveAttribute("data-presence", "open");

    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");

    await exits.finishExits();
    expect(backdrop()).not.toBeInTheDocument();
  });

  it("gives focus back to the opener at the close, while the dialog is still leaving", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole("button", { name: "Open" });
    await user.click(opener);
    expect(screen.getByPlaceholderText("e.g. Active PRs")).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");
    expect(backdrop()).toHaveAttribute("inert");
    expect(opener).toHaveFocus();
    await exits.finishExits();
  });

  it("plays one exit for its own dismiss controls, and calls onClose at once", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    function Dismissable() {
      const [open, setOpen] = useState(true);
      return (
        <Presence when={open}>
          <Modal
            title="T"
            onClose={() => {
              onClose();
              setOpen(false);
            }}
          >
            <input aria-label="field" />
          </Modal>
        </Presence>
      );
    }
    render(<Dismissable />);
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");
    await exits.finishExits();
    expect(backdrop()).not.toBeInTheDocument();
    expect(exits.pending()).toBe(0);
  });

  it("keeps a dialog the parent refuses to close, with no exit", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <Presence when>
        <Modal title="T" onClose={onClose}>
          <input aria-label="field" />
        </Modal>
      </Presence>,
    );
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(backdrop()).toHaveAttribute("data-presence", "open");
    expect(exits.pending()).toBe(0);
  });

  it("does not restore focus to the opener when the action called suppressRestore()", async () => {
    const user = userEvent.setup();
    function Launching() {
      const [open, setOpen] = useState(false);
      const suppress = { current: null as (() => void) | null };
      return (
        <>
          <button onClick={() => setOpen(true)}>Open</button>
          <textarea aria-label="terminal" />
          <Presence when={open}>
            <Modal title="T" onClose={() => setOpen(false)} suppressRestoreRef={suppress}>
              <button
                onClick={() => {
                  screen.getByRole("textbox", { name: "terminal" }).focus();
                  suppress.current?.();
                  setOpen(false);
                }}
              >
                Launch
              </button>
            </Modal>
          </Presence>
        </>
      );
    }
    render(<Launching />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Launch" }));
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");
    expect(screen.getByRole("textbox", { name: "terminal" })).toHaveFocus();
    await exits.finishExits();
    expect(screen.getByRole("textbox", { name: "terminal" })).toHaveFocus();
  });

  it("leaves with the content it had while open, when the call site's payload is gone", async () => {
    function Payload() {
      const [item, setItem] = useState<{ name: string } | null>({ name: "alpha" });
      return (
        <>
          <button onClick={() => setItem(null)}>Clear</button>
          <Presence when={item !== null}>
            {item && (
              <Modal title={item.name} onClose={() => setItem(null)}>
                <p>{item.name} body</p>
              </Modal>
            )}
          </Presence>
        </>
      );
    }
    render(<Payload />);
    act(() => screen.getByRole("button", { name: "Clear" }).click());
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");
    expect(screen.getByText("alpha body")).toBeInTheDocument();
    await exits.finishExits();
    expect(screen.queryByText("alpha body")).not.toBeInTheDocument();
  });

  it("mounts a fresh dialog when reopened while it is leaving", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.type(screen.getByPlaceholderText("e.g. Active PRs"), "typed");
    await user.click(screen.getByRole("button", { name: "Parent close" }));
    expect(backdrop()).toHaveAttribute("data-presence", "leaving");

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(document.querySelectorAll(".create-modal-backdrop")).toHaveLength(1);
    expect(backdrop()).toHaveAttribute("data-presence", "open");
    expect(screen.getByPlaceholderText("e.g. Active PRs")).toHaveValue("");
    await exits.finishExits();
    expect(backdrop()).toHaveAttribute("data-presence", "open");
  });

  it("closes at once under reduced motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn((query: string) => ({
        matches: query.includes("reduce"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      })),
    );
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole("button", { name: "Open" }));
    await user.click(screen.getByRole("button", { name: "Parent close" }));
    expect(backdrop()).not.toBeInTheDocument();
    expect(exits.pending()).toBe(0);
  });

  it("unmounts at once when nothing inside registered an overlay", () => {
    const { rerender } = render(
      <Presence when>
        <p>plain</p>
      </Presence>,
    );
    rerender(
      <Presence when={false}>
        <p>plain</p>
      </Presence>,
    );
    expect(screen.queryByText("plain")).not.toBeInTheDocument();
  });

  it("does not let a dialog opened inside another take its place in the Presence", async () => {
    function Nested() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button onClick={() => setOpen(false)}>Parent close</button>
          <Presence when={open}>
            <Modal title="Outer" onClose={() => setOpen(false)} backdropClassName="outer">
              <Modal title="Inner" onClose={() => {}} backdropClassName="inner">
                <p>inner</p>
              </Modal>
            </Modal>
          </Presence>
        </>
      );
    }
    render(<Nested />);
    act(() => screen.getByRole("button", { name: "Parent close" }).click());
    expect(document.querySelector(".outer")).toHaveAttribute("data-presence", "leaving");
    expect(document.querySelector(".inner")).toHaveAttribute("data-presence", "open");
    await exits.finishExits();
    expect(document.querySelector(".outer")).not.toBeInTheDocument();
  });
});

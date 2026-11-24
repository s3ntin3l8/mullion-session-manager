// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store/index.js";
import { Presence } from "./ui/Presence.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { installExitAnimations } from "./test/exitAnimations.js";
import type { ExitAnimations } from "./test/exitAnimations.js";

// #3015 — the palette's own dismiss controls play its exit (styles/motion.css)
// before they call `onClose`. Kept apart from CommandPalette.test.tsx, which
// is at its size ceiling.
describe("CommandPalette exit", () => {
  let exits: ExitAnimations;
  beforeEach(() => {
    exits = installExitAnimations();
    useDashboardStore.setState({ projects: [], sessions: [] });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse(200, []))),
    );
  });
  afterEach(() => {
    exits.restore();
    vi.unstubAllGlobals();
  });

  function palette(onClose: () => void, onOpenTasks: () => void = () => {}) {
    const noop = () => {};
    return (
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={onClose}
        onOpenSession={noop}
        onOpenGitHub={noop}
        onOpenAgentRules={noop}
        onOpenFileEditor={noop}
        onOpenExternalFile={noop}
        onOpenProjectBriefing={noop}
        onOpenProjectSetup={noop}
        onOpenDockConfig={noop}
        onOpenSkills={noop}
        onOpenBrowser={noop}
        onOpenBlankBrowser={noop}
        onOpenSettingsSection={noop}
        onOpenTasks={onOpenTasks}
        onOpenBrowserUrl={noop}
      />
    );
  }
  function renderPalette(onClose: () => void) {
    return render(palette(onClose));
  }

  // #3037 — App.tsx mounts it in a <Presence>: every close plays the exit,
  // including the ones the palette's own controls never see.
  function PaletteHost({ onOpenTasks }: { onOpenTasks: () => void }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open palette</button>
        <button onClick={() => setOpen(false)}>Global escape</button>
        <Presence when={open}>{palette(() => setOpen(false), onOpenTasks)}</Presence>
      </>
    );
  }

  // The global Escape (useGlobalShortcuts) must not see it: it would unmount
  // the palette in the same batch, before the exit could play.
  it("plays its exit on Escape in the search field, without the global Escape firing", async () => {
    const globalEscape = vi.fn();
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") globalEscape();
    };
    window.addEventListener("keydown", onWindowKey);
    try {
      const user = userEvent.setup();
      const onClose = vi.fn();
      renderPalette(onClose);
      const input = await screen.findByPlaceholderText(
        "Run a command, or find a session or agent…",
      );
      expect(input).toHaveFocus();
      await user.keyboard("{Escape}");
      expect(globalEscape).not.toHaveBeenCalled();
      const backdrop = document.querySelector(".cmd-palette-backdrop");
      expect(backdrop).toHaveClass("motion-scrim");
      expect(backdrop).toHaveAttribute("data-presence", "leaving");
      expect(onClose).not.toHaveBeenCalled();
      await exits.finishExits();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onWindowKey);
    }
  });

  it("plays its exit from the close button and the backdrop too", async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderPalette(onClose);
    await user.click(await screen.findByRole("button", { name: "Close command palette" }));
    expect(document.querySelector(".cmd-palette-backdrop")).toHaveAttribute(
      "data-presence",
      "leaving",
    );
    await exits.finishExits();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("runs a command at once and then plays its exit, focus back on the opener", async () => {
    const user = userEvent.setup();
    const onOpenTasks = vi.fn();
    render(<PaletteHost onOpenTasks={onOpenTasks} />);
    const opener = screen.getByRole("button", { name: "Open palette" });
    await user.click(opener);
    const input = await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    await user.type(input, "Task board");
    // A click, not Enter: user-event would send Enter's keypress on to the
    // opener the focus just went back to, and open the palette again.
    await user.click(screen.getByText("Task board"));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
    const backdrop = document.querySelector(".cmd-palette-backdrop");
    expect(backdrop).toHaveAttribute("data-presence", "leaving");
    expect(opener).toHaveFocus();
    await exits.finishExits();
    expect(document.querySelector(".cmd-palette-backdrop")).not.toBeInTheDocument();
  });

  it("plays its exit when the parent closes it (the global Escape)", async () => {
    const user = userEvent.setup();
    render(<PaletteHost onOpenTasks={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    act(() => screen.getByRole("button", { name: "Global escape" }).click());
    expect(document.querySelector(".cmd-palette-backdrop")).toHaveAttribute(
      "data-presence",
      "leaving",
    );
    await exits.finishExits();
    expect(document.querySelector(".cmd-palette-backdrop")).not.toBeInTheDocument();
  });

  it("closes at once from Escape inside a Presence, and plays the one exit", async () => {
    const user = userEvent.setup();
    render(<PaletteHost onOpenTasks={() => {}} />);
    await user.click(screen.getByRole("button", { name: "Open palette" }));
    await screen.findByPlaceholderText("Run a command, or find a session or agent…");
    await user.keyboard("{Escape}");
    expect(document.querySelector(".cmd-palette-backdrop")).toHaveAttribute(
      "data-presence",
      "leaving",
    );
    await exits.finishExits();
    expect(document.querySelector(".cmd-palette-backdrop")).not.toBeInTheDocument();
    expect(exits.pending()).toBe(0);
  });
});

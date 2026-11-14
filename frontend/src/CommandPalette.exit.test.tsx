// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandPalette } from "./CommandPalette.js";
import { useDashboardStore } from "./store/index.js";
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

  function renderPalette(onClose: () => void) {
    const noop = () => {};
    return render(
      <CommandPalette
        scope="global"
        projectId={null}
        onClose={onClose}
        onLaunched={noop}
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
        onOpenTasks={noop}
        onOpenBrowserUrl={noop}
      />,
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
      const input = await screen.findByPlaceholderText("Launch a session or run a command…");
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
});

// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SHORTCUTS, shortcutLabels } from "../lib/shortcutCatalog.js";
import { InputSection } from "./sections/InputSection.js";
import { ShortcutList } from "./ShortcutList.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";

describe("ShortcutList", () => {
  it("renders every catalog entry's action and the chord labels the catalog formats", () => {
    const hotkey = "Ctrl+Shift+Space";
    render(<ShortcutList voiceHotkey={hotkey} />);

    for (const shortcut of SHORTCUTS) {
      expect(screen.getByText(shortcut.action)).toBeInTheDocument();
      for (const label of shortcutLabels(shortcut, hotkey)) {
        expect(screen.getByText(label)).toBeInTheDocument();
      }
    }
  });

  it("shows a rebound voice hotkey instead of the shipped default", () => {
    render(<ShortcutList voiceHotkey="Ctrl+Shift+Comma" />);

    expect(screen.getByText("Ctrl + Shift + Comma")).toBeInTheDocument();
    expect(screen.queryByText("Ctrl + Shift + Space")).not.toBeInTheDocument();
  });

  it("is what Keyboard & input renders, from the stored voice hotkey", () => {
    useDashboardStore.setState({
      settings: {
        ...DEFAULT_SETTINGS,
        terminal: {
          ...DEFAULT_SETTINGS.terminal,
          voice: { ...DEFAULT_SETTINGS.terminal.voice, hotkey: "Ctrl+Shift+Comma" },
        },
      },
    });
    render(<InputSection />);

    // The action is unique to the cheat sheet. The chord chip is not —
    // KeyChordField prints the same chordLabel — so assert the sheet's
    // own row, not a page-wide text lookup that would also see the field.
    const row = screen.getByText("Voice dictation hotkey").closest(".settings-row");
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("Ctrl + Shift + Comma");
    expect(screen.getByText("Command palette")).toBeInTheDocument();
    expect(screen.getByText("Find in scrollback")).toBeInTheDocument();
  });
});

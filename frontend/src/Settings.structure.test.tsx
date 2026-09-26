// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { SEARCH_INDEX, SECTIONS, resolveSettingsSection } from "./settings/settingsSections.js";
import { useDashboardStore } from "./store/index.js";
import { DEFAULT_SETTINGS } from "./api/index.js";

describe("Settings structure", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no network in test"))),
    );
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gives every section at least one search entry", () => {
    for (const s of SECTIONS) {
      expect(
        SEARCH_INDEX.some((e) => e.section === s.id),
        s.id,
      ).toBe(true);
    }
  });

  it("keeps each group's sections contiguous so each group heading renders once", () => {
    const seen = new Set<string>();
    let prev: string | undefined;
    for (const s of SECTIONS) {
      if (s.group !== prev) {
        expect(seen.has(s.group), s.group).toBe(false);
        seen.add(s.group);
        prev = s.group;
      }
    }
  });

  it("maps folded-in section ids to their new home", () => {
    expect(resolveSettingsSection("models")).toBe("models");
    expect(resolveSettingsSection("skills")).toBe("agent-context");
    expect(resolveSettingsSection("server")).toBe("server");
  });

  it("renders one group heading per group in the nav", () => {
    render(<Settings onClose={vi.fn()} />);
    const headings = Array.from(document.querySelectorAll(".settings-nav-group")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual([...new Set(SECTIONS.map((s) => s.group))]);
  });

  it("search narrows the nav to matching sections and drops empty group headings", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} />);

    await user.type(screen.getByPlaceholderText("Search settings…"), "cookies");

    const items = Array.from(document.querySelectorAll(".settings-nav-item")).map(
      (el) => el.textContent,
    );
    expect(items).toEqual(["Browser"]);
    const headings = Array.from(document.querySelectorAll(".settings-nav-group")).map(
      (el) => el.textContent,
    );
    expect(headings).toEqual(["Workspace"]);
  });

  it("labels the close button", () => {
    render(<Settings onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Close settings" })).toBeInTheDocument();
  });
});

describe("Settings -> Projects -> Git auto-fetch interval", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("no network in test"))),
    );
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("lives in Projects and writes sessions.gitAutoFetchIntervalSeconds", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="projects" />);

    const row = screen.getByText("Git auto-fetch interval").closest(".settings-row")!;
    const input = row.querySelector("input")!;
    expect(input).toHaveValue(DEFAULT_SETTINGS.sessions.gitAutoFetchIntervalSeconds);

    await user.clear(input);
    await user.type(input, "120");

    expect(useDashboardStore.getState().settings.sessions.gitAutoFetchIntervalSeconds).toBe(120);
  });
});

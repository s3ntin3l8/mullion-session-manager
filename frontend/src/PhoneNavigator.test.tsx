// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneNavigatorHeader, PhoneNavigatorPanel, PhoneSettingsList } from "./PhoneNavigator.js";
import { sidebarPhoneSection } from "./lib/phoneNavSection.js";
import { useDashboardStore } from "./store/index.js";
import { resetStore } from "./test/resetStore.js";
import { SECTIONS } from "./settings/settingsSections.js";

function header(over: Partial<Parameters<typeof PhoneNavigatorHeader>[0]> = {}) {
  const props = {
    tab: "projects" as const,
    onTab: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<PhoneNavigatorHeader {...props} />);
  return props;
}

describe("PhoneNavigatorHeader", () => {
  it("marks the selected tab and switches tabs", async () => {
    const props = header({ tab: "settings" });
    expect(screen.getByRole("button", { name: "Settings" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    // Devices are a right-sidebar view (#3012), not a navigator tab.
    expect(screen.queryByRole("button", { name: "Devices" })).toBeNull();
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(props.onTab).toHaveBeenCalledWith("projects");
  });

  it("Tasks is a regular tab", async () => {
    const props = header({ tab: "tasks" });
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(props.onTab).toHaveBeenLastCalledWith("tasks");
  });

  it("closes", async () => {
    const props = header();
    await userEvent.click(screen.getByRole("button", { name: "Close navigator" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PhoneSettingsList", () => {
  it("lists every settings section under its group and opens the chosen one", async () => {
    const onSelect = vi.fn();
    render(<PhoneSettingsList onSelect={onSelect} />);
    // Every section except "Dock & previews", which configures the desktop
    // Dock that phone hides.
    for (const s of SECTIONS.filter((x) => x.id !== "dock")) {
      expect(screen.getByRole("button", { name: new RegExp(s.title) })).toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Dock & previews/ })).toBeNull();
    const groups = new Set(SECTIONS.map((s) => s.group));
    for (const g of groups) expect(screen.getByText(g)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    expect(onSelect).toHaveBeenCalledWith("terminal");
  });

  // Issue #1880 — the phone's list showed every section unfiltered, so
  // finding one of the 18 meant scrolling past all of them, while the
  // desktop's rail has filtered since the search index landed.
  it("filters the list by section name", async () => {
    render(<PhoneSettingsList onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search settings"), "terminal");

    expect(screen.getByRole("button", { name: /Terminal/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Storage/ })).toBeNull();
  });

  it("filters the list by section description, not just by name", async () => {
    // The description is what the desktop's rail did NOT match, so this is
    // the part that is new to the phone: "sign-in cookies" is in Browser's
    // description and in no section's title.
    render(<PhoneSettingsList onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search settings"), "sign-in cookies");

    expect(screen.getByRole("button", { name: /Browser/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Storage/ })).toBeNull();
  });

  it("drops the group headings of the sections the filter removed", async () => {
    const { container } = render(<PhoneSettingsList onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search settings"), "terminal");

    const groups = Array.from(container.querySelectorAll(".phone-nav-settings-group")).map(
      (el) => el.textContent,
    );
    // "Terminal" is a Personal section; the other four groups go away with
    // the sections the filter removed.
    expect(groups).toEqual(["Personal"]);
  });

  it("says so when nothing matches", async () => {
    render(<PhoneSettingsList onSelect={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Search settings"), "zzzz");

    expect(screen.getByText("No matching settings.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Terminal/ })).toBeNull();
  });

  it("clearing the query brings every section back", async () => {
    render(<PhoneSettingsList onSelect={vi.fn()} />);
    const input = screen.getByLabelText("Search settings");
    await userEvent.type(input, "terminal");
    await userEvent.clear(input);

    for (const s of SECTIONS.filter((x) => x.id !== "dock")) {
      expect(screen.getByRole("button", { name: new RegExp(s.title) })).toBeInTheDocument();
    }
  });
});

describe("PhoneNavigatorPanel", () => {
  beforeEach(() => resetStore());
  function panel(over: Partial<Parameters<typeof PhoneNavigatorPanel>[0]> = {}) {
    const props = {
      navTab: "projects" as const,
      setNavTab: vi.fn(),
      onOpenTasks: vi.fn(),
      onClose: vi.fn(),
      onSelectSetting: vi.fn(),
      sidebar: <div>SIDEBAR</div>,
      ...over,
    };
    render(<PhoneNavigatorPanel {...props} />);
    return props;
  }

  it("shows the sidebar by default", () => {
    panel();
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
  });

  it("shows the workspaces slot above the sidebar on the Projects tab only", () => {
    panel({ workspaces: <div>WORKSPACES</div> });
    expect(screen.getByText("WORKSPACES")).toBeInTheDocument();
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
  });

  it("omits the workspaces slot on the Settings tab", () => {
    panel({ navTab: "settings", workspaces: <div>WORKSPACES</div> });
    expect(screen.queryByText("WORKSPACES")).toBeNull();
  });

  it("keeps the board out of the drawer: Tasks mode is the grid overlay (#3009)", () => {
    useDashboardStore.getState().setViewMode("kanban");
    panel();
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-pressed", "false");
  });

  it("shows the settings list on the Settings tab", () => {
    panel({ navTab: "settings" });
    expect(screen.getByRole("button", { name: /Account/ })).toBeInTheDocument();
  });

  it("Tasks tab switches to Tasks mode; other tabs switch the tab", async () => {
    const open = panel();
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(open.onOpenTasks).toHaveBeenCalledTimes(1);
    expect(open.setNavTab).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(open.setNavTab).toHaveBeenCalledWith("settings");
  });
});

describe("sidebarPhoneSection", () => {
  it("only maps Projects", () => {
    expect(sidebarPhoneSection("projects")).toBe("projects");
    expect(sidebarPhoneSection("tasks")).toBeUndefined();
    expect(sidebarPhoneSection("settings")).toBeUndefined();
  });
});

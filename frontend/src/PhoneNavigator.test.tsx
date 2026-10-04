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
    const props = header({ tab: "devices" });
    expect(screen.getByRole("button", { name: "Devices" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(props.onTab).toHaveBeenCalledWith("settings");
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
});

vi.mock("./panels/registry.js", () => ({
  KanbanBoardOverlay: () => <div>BOARD</div>,
}));

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
      onOpenSession: vi.fn(),
      onSessionEnded: vi.fn(),
      ...over,
    };
    render(<PhoneNavigatorPanel {...props} />);
    return props;
  }

  it("shows the sidebar by default and the board in place when Tasks is open", () => {
    panel();
    expect(screen.getByText("SIDEBAR")).toBeInTheDocument();
    expect(screen.queryByText("BOARD")).toBeNull();
  });

  it("shows the board and marks Tasks pressed while tasksOpen", () => {
    useDashboardStore.getState().setViewMode("kanban");
    panel();
    expect(screen.getByText("BOARD")).toBeInTheDocument();
    expect(screen.queryByText("SIDEBAR")).toBeNull();
    expect(screen.getByRole("button", { name: "Tasks" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the settings list on the Settings tab", () => {
    panel({ navTab: "settings" });
    expect(screen.getByRole("button", { name: /Account/ })).toBeInTheDocument();
  });

  it("Tasks tab opens the board; other tabs switching tab keeps the list view", async () => {
    const open = panel();
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(open.onOpenTasks).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Devices" }));
    expect(open.setNavTab).toHaveBeenCalledWith("devices");
  });

  it("switching away from an open Tasks board leaves Tasks", async () => {
    useDashboardStore.getState().setViewMode("kanban");
    const p = panel();
    await userEvent.click(screen.getByRole("button", { name: "Projects" }));
    expect(p.setNavTab).toHaveBeenCalledWith("projects");
    expect(useDashboardStore.getState().viewMode).toBe("list");
  });
});

describe("sidebarPhoneSection", () => {
  it("only maps Projects and Devices", () => {
    expect(sidebarPhoneSection("projects")).toBe("projects");
    expect(sidebarPhoneSection("devices")).toBe("devices");
    expect(sidebarPhoneSection("tasks")).toBeUndefined();
    expect(sidebarPhoneSection("settings")).toBeUndefined();
  });
});

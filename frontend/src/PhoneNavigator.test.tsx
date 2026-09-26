// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PhoneNavigatorHeader, PhoneSettingsList } from "./PhoneNavigator.js";
import { SECTIONS } from "./settings/settingsSections.js";

function header(over: Partial<Parameters<typeof PhoneNavigatorHeader>[0]> = {}) {
  const props = {
    tab: "projects" as const,
    onTab: vi.fn(),
    onOpenTasks: vi.fn(),
    tasksActive: false,
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

  it("Tasks enters the board instead of selecting a tab", async () => {
    const props = header();
    await userEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(props.onOpenTasks).toHaveBeenCalledTimes(1);
    expect(props.onTab).not.toHaveBeenCalled();
  });

  it("shows Tasks as pressed while the board is open, and closes", async () => {
    const props = header({ tasksActive: true });
    const tasks = screen.getByRole("button", { name: "Tasks" });
    expect(tasks).toHaveAttribute("aria-current", "page");
    expect(tasks).not.toHaveAttribute("aria-pressed");
    await userEvent.click(screen.getByRole("button", { name: "Close navigator" }));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe("PhoneSettingsList", () => {
  it("lists every settings section under its group and opens the chosen one", async () => {
    const onSelect = vi.fn();
    render(<PhoneSettingsList onSelect={onSelect} />);
    for (const s of SECTIONS) {
      expect(screen.getByRole("button", { name: new RegExp(s.title) })).toBeInTheDocument();
    }
    const groups = new Set(SECTIONS.map((s) => s.group));
    for (const g of groups) expect(screen.getByText(g)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Terminal/ }));
    expect(onSelect).toHaveBeenCalledWith("terminal");
  });
});

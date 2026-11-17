// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RightSidebarPanel } from "./RightSidebarPanel.js";
import { SidebarHeader } from "./SidebarHeader.js";
import { DetailHeader } from "../ui/sidebar/DetailHeader.js";
import type { FollowedProject } from "../hooks/useFollowedProject.js";
import type { RightSidebarActions, RightSidebarView } from "./views.js";
import { GridIcon } from "../ui/icons.js";

const followed: FollowedProject = {
  effectiveProjectId: null,
  followSourceId: null,
  pinnedProjectId: null,
  setPinnedProjectId: () => {},
  dropdownOptions: [],
  dropdownValue: "",
  onDropdownChange: () => {},
};

// Host-global, so the panel needs no project: what is under test is its head.
function stubView(Body: () => React.ReactNode): RightSidebarView {
  return {
    id: "stub",
    label: "Stub",
    icon: GridIcon,
    useBadge: () => null,
    useEnabled: () => true,
    hostGlobal: true,
    Component: Body,
  };
}

function renderPanel(view: RightSidebarView, phone: boolean) {
  const onClose = vi.fn();
  render(
    // The class DetailHeader marks while a detail fills the header's slot.
    <section className="right-sidebar-panel">
      <RightSidebarPanel
        view={view}
        followed={followed}
        actions={{} as RightSidebarActions}
        onClose={onClose}
        phone={phone}
        title="Stub view"
      />
    </section>,
  );
  return { onClose };
}

afterEach(cleanup);

// #3216 — on the phone the mode bar is the way out of a view.
describe("RightSidebarPanel on the phone", () => {
  it("names a top-level view and has no Back control", () => {
    renderPanel(
      stubView(() => <SidebarHeader label="Stub" />),
      true,
    );
    expect(screen.getByRole("heading", { name: "Stub view" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Close sidebar" })).toBeNull();
  });

  it("keeps a pushed detail's own Back, which goes back to the list", async () => {
    const onBack = vi.fn();
    renderPanel(
      stubView(() => <DetailHeader title="#7" onBack={onBack} />),
      true,
    );
    const slot = document.querySelector<HTMLElement>(".right-sidebar-detail-slot")!;
    await userEvent.click(within(slot).getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
    // The panel is marked, so the head steps aside for the detail (mobile.css).
    expect(document.querySelector(".right-sidebar-panel")).toHaveAttribute("data-sidebar-detail");
  });

  it("names the view once: the strip keeps only its context", () => {
    renderPanel(
      stubView(() => <SidebarHeader label="Stub" context="main · 3 changes" />),
      true,
    );
    const strip = document.querySelector(".right-sidebar-strip-slot")!;
    expect(strip.textContent).toBe("main · 3 changes");
    expect(screen.getAllByText(/Stub/)).toHaveLength(1);
  });

  it("leaves the strip out when the name is all it carries", () => {
    renderPanel(
      stubView(() => <SidebarHeader label="Stub" />),
      true,
    );
    expect(document.querySelector(".right-sidebar-strip-slot")).toBeEmptyDOMElement();
  });

  it("keeps the docked sidebar's close button and the name in its strip", async () => {
    const { onClose } = renderPanel(
      stubView(() => <SidebarHeader label="Stub" />),
      false,
    );
    expect(screen.queryByRole("heading", { name: "Stub view" })).toBeNull();
    expect(document.querySelector(".right-sidebar-strip-slot")!.textContent).toBe("Stub");
    await userEvent.click(screen.getByRole("button", { name: "Close sidebar" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

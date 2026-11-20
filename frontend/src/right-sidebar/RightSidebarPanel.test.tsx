// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
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

describe("RightSidebarPanel detail slot", () => {
  it("mounts the view once the header's slots exist, so a detail never remounts into them", () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Detail() {
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <DetailHeader title="#7" onBack={() => {}} />;
    }
    renderPanel(
      stubView(() => <Detail />),
      false,
    );
    const slot = document.querySelector<HTMLElement>(".right-sidebar-detail-slot")!;
    expect(within(slot).getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it("lands focus on the panel when a detail closes and nothing else takes it", async () => {
    function Switch() {
      const [open, setOpen] = useState(true);
      return open ? <DetailHeader title="#7" onBack={() => setOpen(false)} /> : <div>list</div>;
    }
    renderPanel(
      stubView(() => <Switch />),
      false,
    );
    const slot = document.querySelector<HTMLElement>(".right-sidebar-detail-slot")!;
    within(slot).getByRole("button", { name: "Back" }).focus();
    await userEvent.click(within(slot).getByRole("button", { name: "Back" }));
    expect(screen.getByText("list")).toBeInTheDocument();
    expect(document.activeElement).toBe(document.querySelector(".right-sidebar-panel"));
  });

  it("leaves focus alone when it already sits outside the closing detail", async () => {
    function Switch() {
      const [open, setOpen] = useState(true);
      return open ? <DetailHeader title="#7" onBack={() => setOpen(false)} /> : <div>list</div>;
    }
    renderPanel(
      stubView(() => <Switch />),
      false,
    );
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const slot = document.querySelector<HTMLElement>(".right-sidebar-detail-slot")!;
    // Back is clicked without taking focus, as a pointer on a non-focusing
    // surface would; focus stays on the rail-like control outside the panel.
    outside.focus();
    act(() => within(slot).getByRole("button", { name: "Back" }).click());
    expect(screen.getByText("list")).toBeInTheDocument();
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});

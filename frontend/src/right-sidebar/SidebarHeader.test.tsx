// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SidebarHeader } from "./SidebarHeader.js";
import { SidebarStripSlotContext, SidebarToolbarSlotContext } from "./sidebarToolbarSlot.js";
import { DetailHeader } from "../ui/sidebar/DetailHeader.js";
import { SidebarDetailSlotContext } from "../ui/sidebar/detailSlot.js";
import { RefreshIcon } from "../ui/icons.js";

const actions = (onClick = vi.fn()) => [
  { key: "refresh", label: "Refresh", icon: RefreshIcon, onClick, dot: "warn" as const },
];

describe("SidebarHeader", () => {
  it("renders the buttons, the ⋯ menu and the strip inline outside the drawer", async () => {
    const onRefresh = vi.fn();
    const onOpen = vi.fn();
    render(
      <SidebarHeader
        label="GitHub"
        context="5 open PRs"
        actions={actions(onRefresh)}
        overflow={[{ key: "open", label: "Open on GitHub", onClick: onOpen }]}
      />,
    );

    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("5 open PRs")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "More actions" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Open on GitHub" }));
    expect(onOpen).toHaveBeenCalled();
  });

  it("puts the strip and the buttons into their drawer slots, with the dot on a button", () => {
    const toolbar = document.createElement("div");
    const strip = document.createElement("div");
    document.body.append(toolbar, strip);
    const { container } = render(
      <SidebarToolbarSlotContext.Provider value={toolbar}>
        <SidebarStripSlotContext.Provider value={strip}>
          <SidebarHeader label="History" context="main" actions={actions()} />
        </SidebarStripSlotContext.Provider>
      </SidebarToolbarSlotContext.Provider>,
    );

    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector(".sb-strip")).toBeNull();
    expect(toolbar.querySelector("button[aria-label='Refresh'] .sb-ibtn-dot--warn")).toBeTruthy();
    expect(strip.querySelector(".sb-strip")?.textContent).toBe("Historymain");
    toolbar.remove();
    strip.remove();
  });

  it("keeps the ⋯ menu after the icon buttons in the same bar", () => {
    render(
      <SidebarHeader
        label="Files"
        actions={actions()}
        overflow={[{ key: "x", label: "Upload", onClick: vi.fn() }]}
      />,
    );
    const bar = screen.getByRole("toolbar");
    const names = Array.from(bar.querySelectorAll("button")).map((b) =>
      b.getAttribute("aria-label"),
    );
    expect(names).toEqual(["Refresh", "More actions"]);
  });

  it("omits the ⋯ menu when there is no overflow, and the context when there is none", () => {
    render(<SidebarHeader label="Project" />);
    expect(screen.queryByRole("button", { name: "More actions" })).toBeNull();
    expect(document.querySelector(".sb-strip span")).toBeNull();
  });
});

describe("DetailHeader in the drawer", () => {
  it("renders inline outside the drawer, and keeps the GitHub link owned by the toolbar", () => {
    render(
      <DetailHeader onBack={() => {}} title="#7" externalUrl="https://github.com/o/r/pull/7" />,
    );
    expect(document.querySelector(".sb-vh--bare")).toBeNull();
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy();
  });

  it("takes over the detail slot, drops its own bar, and goes back", async () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const onBack = vi.fn();
    const { container } = render(
      <SidebarDetailSlotContext.Provider value={slot}>
        <DetailHeader
          onBack={onBack}
          title="#7 · fix"
          subtitle="main ← fix"
          externalUrl="https://github.com/o/r/pull/7"
          externalLabel="Open PR #7 on GitHub"
        />
      </SidebarDetailSlotContext.Provider>,
    );

    expect(container.querySelector(".sb-vh")).toBeNull();
    expect(slot.querySelector(".sb-vh--bare")?.textContent).toContain("#7 · fix");
    // The toolbar is hidden while a detail is open, so the link shows here.
    expect(slot.querySelector("a[aria-label='Open PR #7 on GitHub']")).toBeTruthy();
    await userEvent.click(slot.querySelector("button[aria-label='Back']") as HTMLElement);
    expect(onBack).toHaveBeenCalled();
    slot.remove();
  });

  it("ignores `sticky` in the drawer's header row (the row is already fixed)", () => {
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    render(
      <SidebarDetailSlotContext.Provider value={slot}>
        <DetailHeader onBack={() => {}} title="#7" sticky />
      </SidebarDetailSlotContext.Provider>,
    );
    expect(slot.querySelector(".sb-vh--sticky")).toBeNull();
    expect(slot.querySelector(".sb-vh--bare")).toBeTruthy();
    slot.remove();
  });
});

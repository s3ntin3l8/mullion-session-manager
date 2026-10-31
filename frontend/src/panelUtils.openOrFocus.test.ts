// The openOrFocusPanel helper (issue #2410) — the one open-or-focus
// preamble every panel opener in panelUtils.ts routes through.
//
// panelUtils.test.ts keeps covering the openers themselves (it is
// baselined and may not grow); this file pins the HELPER's own contract:
// the two ways the eleven openers used to differ from each other —
// re-targeting an already-open panel, and the conditional desktop/tablet
// positioning — plus the phone maximize and the explicit placement a
// drag-and-drop brings along.
import { describe, it, expect, vi } from "vitest";
import { openOrFocusPanel } from "./panelUtils.js";
import type { DockviewApi, DockviewGroupPanel } from "dockview";
import type { LayoutContext } from "./lib/layoutTier.js";

// `location.type` mirrors the live dockview panel API the module reads to
// decide float-vs-dock (issue #121): "grid" for anything actually tiled,
// "floating" for a peek panel.
function mockPanel(id: string, locationType: "grid" | "floating" = "grid") {
  return {
    id,
    api: {
      setActive: vi.fn(),
      close: vi.fn(),
      updateParameters: vi.fn(),
      location: { type: locationType },
    },
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
}

// A grid-target group — real DockviewGroupPanels expose `api.location.type`
// directly (isTiledGroup reads that, not the group's panel list).
function mockGroup(id: string, locationType: "grid" | "floating" = "grid") {
  return {
    id,
    api: { location: { type: locationType } },
  } as unknown as DockviewGroupPanel;
}

function mockDockviewApi(): DockviewApi {
  const panels = new Map<string, ReturnType<DockviewApi["getPanel"]>>();
  return {
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    addPanel: vi.fn((opts) => {
      const p = mockPanel(opts.id, opts.floating ? "floating" : "grid");
      panels.set(opts.id, p);
      return p;
    }),
    maximizeGroup: vi.fn(),
    get panels() {
      return Array.from(panels.values());
    },
  } as unknown as DockviewApi;
}

const DESKTOP: LayoutContext = { tier: "desktop", tabletPaneCap: 2 };
const TABLET: LayoutContext = { tier: "tablet", tabletPaneCap: 2 };
const PHONE: LayoutContext = { tier: "phone", tabletPaneCap: 2 };

const SPEC = {
  component: "terminal",
  tabComponent: "terminal",
  title: "a session",
  params: { sessionId: 1 },
};

describe("openOrFocusPanel", () => {
  it("focuses an already-open panel instead of opening a second one", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const existing = api.getPanel("session-1")!;

    openOrFocusPanel(api, "session-1", SPEC, DESKTOP);

    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    // No retarget params: the open panel is left exactly as it was.
    expect(existing.api.updateParameters).not.toHaveBeenCalled();
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("re-targets an already-open panel when the spec carries retarget params", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const existing = api.getPanel("session-1")!;

    openOrFocusPanel(
      api,
      "session-1",
      { ...SPEC, retargetParams: { projectId: 7, rev: 42 } },
      DESKTOP,
    );

    expect(existing.api.updateParameters).toHaveBeenCalledWith({ projectId: 7, rev: 42 });
    expect(existing.api.setActive).toHaveBeenCalledTimes(1);
    expect(api.addPanel).toHaveBeenCalledTimes(1); // only the setup call
  });

  it("applies the tier positioning by default — a desktop panel floats once one is tiled", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusPanel(api, "session-2", SPEC, DESKTOP);

    expect(api.addPanel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "session-2", floating: { width: 720, height: 460 } }),
    );
  });

  it("omits the positioning when the spec opts out of desktop positioning", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusPanel(api, "session-2", { ...SPEC, applyDesktopPositioning: false }, DESKTOP);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(addCall).not.toHaveProperty("position");
  });

  it("omits the tablet positioning too when the spec opts out of desktop positioning", () => {
    const api = mockDockviewApi();

    openOrFocusPanel(api, "session-2", { ...SPEC, applyDesktopPositioning: false }, TABLET);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(addCall).not.toHaveProperty("position");
  });

  // Issue #1452 — phone has its own gate: it always positions explicitly,
  // so a panel never bare-adds into a stranded floating activeGroup, even
  // for the panel kind that opts out of the desktop/tablet positioning.
  it("still positions on phone when the spec opts out of desktop positioning", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled
    (api as unknown as { activeGroup: DockviewGroupPanel }).activeGroup = mockGroup(
      "float-group",
      "floating",
    );

    openOrFocusPanel(api, "session-2", { ...SPEC, applyDesktopPositioning: false }, PHONE);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).toEqual(
      expect.objectContaining({
        position: {
          referencePanel: expect.objectContaining({ id: "session-1" }),
          direction: "within",
        },
      }),
    );
    expect(addCall).not.toHaveProperty("floating");
  });

  it("maximizes a newly opened panel on phone, and never on desktop", () => {
    const api = mockDockviewApi();

    openOrFocusPanel(api, "session-2", SPEC, PHONE);
    expect(api.maximizeGroup).toHaveBeenCalledTimes(1);

    const desktopApi = mockDockviewApi();
    openOrFocusPanel(desktopApi, "session-2", SPEC, DESKTOP);
    expect(desktopApi.maximizeGroup).not.toHaveBeenCalled();
  });

  it("maximizes a re-focused panel on phone", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const existing = api.getPanel("session-1")!;

    openOrFocusPanel(api, "session-1", SPEC, PHONE);

    expect(api.maximizeGroup).toHaveBeenCalledWith(existing);
  });

  it("uses an explicit placement instead of the tier positioning", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusPanel(api, "session-2", { ...SPEC, position: { direction: "right" } }, DESKTOP);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).toEqual(expect.objectContaining({ position: { direction: "right" } }));
    expect(addCall).not.toHaveProperty("floating");
  });

  // The drag-and-drop path (dropSessionPanel) has no tier to position for:
  // it places the panel itself and has never maximized it.
  it("neither positions nor maximizes without a layout", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} }); // tiled

    openOrFocusPanel(api, "session-2", { ...SPEC, position: { direction: "right" } });

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).toEqual(expect.objectContaining({ position: { direction: "right" } }));
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });
});

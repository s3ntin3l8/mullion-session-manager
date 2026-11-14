// @vitest-environment jsdom
// #3010 — panelUtils while the two halves show (800-1099px): placement, the
// router, and the one-pane presentation. Its own file: panelUtils.test.ts is
// at its size ceiling.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockviewApi, DockviewGroupPanel } from "dockview";
import type { Session } from "./api/index.js";
import type { LayoutContext } from "./lib/layoutTier.js";
import {
  applyLayoutPresentation,
  focusPanelForTier,
  openSessionPanel,
  setHalvesRouter,
} from "./panelUtils.js";
import { makeSession } from "./test/fixtures.js";

function mockPanel(id: string, locationType: "grid" | "floating" = "grid") {
  return {
    id,
    api: { setActive: vi.fn(), close: vi.fn(), location: { type: locationType } },
  } as unknown as ReturnType<DockviewApi["getPanel"]>;
}

function mockDockviewApi(): DockviewApi {
  const panels = new Map<string, ReturnType<DockviewApi["getPanel"]>>();
  return {
    getPanel: vi.fn((id: string) => panels.get(id) ?? null),
    addPanel: vi.fn((opts: { id: string; floating?: unknown }) => {
      const p = mockPanel(opts.id, opts.floating ? "floating" : "grid");
      panels.set(opts.id, p);
      return p;
    }),
    maximizeGroup: vi.fn(),
    activeGroup: undefined,
    get panels() {
      return Array.from(panels.values());
    },
  } as unknown as DockviewApi;
}

function mockApiForPresentation(opts: {
  maximized: boolean;
  panels?: ReturnType<DockviewApi["getPanel"]>[];
  activePanel?: ReturnType<DockviewApi["getPanel"]> | null;
  groups?: DockviewGroupPanel[];
}): DockviewApi {
  return {
    hasMaximizedGroup: vi.fn(() => opts.maximized),
    exitMaximizedGroup: vi.fn(),
    maximizeGroup: vi.fn(),
    panels: opts.panels ?? [],
    activePanel: opts.activePanel ?? null,
    groups: opts.groups ?? [],
  } as unknown as DockviewApi;
}

const PROJECTS = [{ id: 1, name: "project-alpha" }];
const TABLET_LAYOUT: LayoutContext = { tier: "tablet" };
const NEW_SESSION: Session = makeSession({ id: 2, projectId: 1 });

// #3010 — while the two halves show (800-1099px), a new pane lands in a tiled
// group, never a float (a float cannot be maximized onto the left half), and
// the halves' router places it.
describe("positioning while the halves show", () => {
  afterEach(() => setHalvesRouter(null));

  it("adds into a tiled group and hands the new pane to the router", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const router = vi.fn(() => true);
    setHalvesRouter(router);

    openSessionPanel(api, NEW_SESSION, TABLET_LAYOUT, PROJECTS);

    const addCall = (api.addPanel as ReturnType<typeof vi.fn>).mock.calls[1][0];
    expect(addCall).not.toHaveProperty("floating");
    expect(router).toHaveBeenCalledWith(api, expect.objectContaining({ id: "session-2" }));
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });

  it("routes a focus of an open pane through the router", () => {
    const api = mockDockviewApi();
    api.addPanel({ id: "session-1", component: "terminal", params: {} });
    const panel = api.getPanel("session-1")!;
    const router = vi.fn(() => true);
    setHalvesRouter(router);
    focusPanelForTier(api, panel, "tablet");
    expect(router).toHaveBeenCalledWith(api, panel);
    expect(panel.api.setActive).not.toHaveBeenCalled();
  });
});

describe("applyLayoutPresentation in the halves", () => {
  // #3010 — the halves (800-1099px) are a one-pane presentation like the
  // phone: tiled headers hidden, one group maximized for the left half.
  it("halves: hides tiled headers and maximizes, preferring the pane asked for", () => {
    const a = mockPanel("session-1");
    const b = mockPanel("session-2");
    const group = { header: { hidden: false }, api: { location: { type: "grid" } } };
    const api = {
      ...mockApiForPresentation({
        maximized: true,
        panels: [a, b],
        activePanel: a,
        groups: [group as unknown as DockviewGroupPanel],
      }),
      getPanel: (id: string) => [a, b].find((p) => p?.id === id),
    } as unknown as DockviewApi;

    applyLayoutPresentation(api, "halves", "session-2");

    expect(group.header.hidden).toBe(true);
    expect(b?.api.setActive).toHaveBeenCalled();
    expect(api.maximizeGroup).toHaveBeenCalledWith(b);
    expect(api.exitMaximizedGroup).not.toHaveBeenCalled();
  });

  it("halves: keeps an existing maximize when no pane is preferred, or the preferred one floats", () => {
    const a = mockPanel("session-1");
    const float = mockPanel("session-3", "floating");
    const api = {
      ...mockApiForPresentation({ maximized: true, panels: [a, float], activePanel: a }),
      getPanel: (id: string) => [a, float].find((p) => p?.id === id),
    } as unknown as DockviewApi;
    applyLayoutPresentation(api, "halves", null);
    applyLayoutPresentation(api, "halves", "session-3");
    expect(api.maximizeGroup).not.toHaveBeenCalled();
  });
});

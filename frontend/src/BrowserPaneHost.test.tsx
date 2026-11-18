// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewPanelApi, IDockviewPanelProps } from "dockview-react";
import { BrowserPaneHost } from "./BrowserPaneHost.js";
import type { BrowserHostComponent, BrowserHostParams } from "./BrowserPaneHost.js";
import { components } from "./panels/registry.js";
import { useDashboardStore } from "./store/index.js";
import type { Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject, makeSession } from "./test/fixtures.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";
import { SERVER_INFO_FIXTURE } from "./test/serverInfoFixture.js";

// Both engines are stand-ins. Each keeps an address of its own in local
// state, so a test can tell whether a body stayed mounted across a switch,
// and renders the toolbar slots the pane hands it. Mounting the real
// BrowserPane is what launches a session's browser.
function StandIn(props: {
  testId: string;
  params: object;
  toolbarStart?: ReactNode;
  toolbarEnd?: ReactNode;
}) {
  const [address, setAddress] = useState("");
  return (
    <div data-testid={props.testId} data-params={JSON.stringify(props.params)}>
      <div className="browser-panel-toolbar">
        {props.toolbarStart}
        <input
          aria-label={`${props.testId} address`}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        {props.toolbarEnd}
      </div>
    </div>
  );
}
vi.mock("./BrowserPanel.js", () => ({
  BrowserPanel: (props: { params: object; toolbarStart?: ReactNode }) => (
    <StandIn testId="preview" {...props} />
  ),
}));
vi.mock("./BrowserPane.js", () => ({
  BrowserPane: (props: { params: { sessionId: number }; toolbarStart?: ReactNode }) => (
    <StandIn testId={`agent-${props.params.sessionId}`} {...props} />
  ),
}));

const session = (id: number, over: Partial<Session> = {}) =>
  makeSession({ id, projectId: 1, name: `agent ${id}`, nameLocked: true, ...over });

// A dockview panel api that merges params like dockview does and re-renders
// the pane with them, so a test sees what a saved layout would hold.
function makePanelApi(initialTitle: string) {
  let params: BrowserHostParams = {};
  let rerender: (() => void) | null = null;
  const api = {
    title: initialTitle,
    setTitle: vi.fn((t: string) => {
      api.title = t;
    }),
    close: vi.fn(),
    updateParameters: vi.fn((patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...params, ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
      params = next as BrowserHostParams;
      // Dockview re-renders the panel after the call returns, not inside it
      // (a write from an effect would otherwise re-enter React's commit).
      queueMicrotask(() => act(() => rerender?.()));
    }),
  };
  return {
    api,
    get params() {
      return params;
    },
    setParams(p: BrowserHostParams) {
      params = p;
    },
    bind(fn: () => void) {
      rerender = fn;
    },
  };
}

function renderHost(component: BrowserHostComponent, params: BrowserHostParams, title = "") {
  const panel = makePanelApi(title);
  panel.setParams(params);
  const ui = () => (
    <BrowserPaneHost
      params={panel.params}
      api={panel.api as unknown as DockviewPanelApi}
      component={component}
    />
  );
  const result = render(ui());
  panel.bind(() => result.rerender(ui()));
  return { ...result, panel, rerender: () => result.rerender(ui()) };
}

const switchGroup = () => screen.getByRole("radiogroup", { name: "Browser mode" });
const previewRadio = () => within(switchGroup()).getByRole("radio", { name: "Preview" });
const agentRadio = () => within(switchGroup()).getByRole("radio", { name: /Agent's browser/ });

describe("BrowserPaneHost (#3371)", () => {
  let bindings: Record<number, unknown[]>;
  let probes: number[];
  let browserEnabled: boolean;

  beforeEach(() => {
    bindings = {};
    probes = [];
    browserEnabled = true;
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": ({ params }) => {
        const id = Number(params.id);
        probes.push(id);
        return jsonResponse(200, bindings[id] ?? []);
      },
      "GET /api/server-info": () =>
        jsonResponse(200, {
          ...SERVER_INFO_FIXTURE,
          features: { ...SERVER_INFO_FIXTURE.features, browser: browserEnabled },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({
      projects: [makeProject({ id: 1, name: "aurora" })],
      sessions: [session(5), session(6)],
      sessionsLoaded: true,
      activePanelId: "session-5",
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("the switch", () => {
    it("keeps each mode's address when switching both ways", async () => {
      const user = userEvent.setup();
      bindings[5] = [{ sessionId: 5 }];
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");

      await user.type(screen.getByLabelText("preview address"), "http://localhost:5173/a");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      await user.type(await screen.findByLabelText("agent-5 address"), "https://example.com/b");

      await user.click(previewRadio());
      expect(screen.getByLabelText("preview address")).toHaveValue("http://localhost:5173/a");

      await user.click(agentRadio());
      expect(screen.getByLabelText("agent-5 address")).toHaveValue("https://example.com/b");
      // Only the shown mode is in the accessibility tree.
      expect(screen.queryByRole("textbox", { name: "preview address" })).toBeNull();
    });

    it("names the session it would show and marks the current mode", async () => {
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      expect(
        await screen.findByRole("radio", { name: "Agent's browser · agent 5" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(previewRadio()).toHaveAttribute("aria-checked", "true");
    });

    it("sits first in the toolbar, before the address", async () => {
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await screen.findByRole("radiogroup", { name: "Browser mode" });
      const toolbar = screen.getByTestId("preview").querySelector(".browser-panel-toolbar")!;
      expect(toolbar.firstElementChild).toBe(switchGroup());
    });
  });

  describe("the probe", () => {
    it("asks for the session's browser before attaching, and attaches a bound one", async () => {
      const user = userEvent.setup();
      bindings[5] = [{ sessionId: 5 }];
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
      expect(probes).toEqual([5]);
    });

    it("never starts a browser by itself: a session without one gets Open browser", async () => {
      const user = userEvent.setup();
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(await screen.findByText("agent 5 has no browser yet.")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-5")).toBeNull();
      // The switch is still there in this state, to go back.
      expect(previewRadio()).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Open browser" }));
      expect(screen.getByTestId("agent-5")).toBeInTheDocument();
    });

    it("shows Loading while the probe is out", async () => {
      const user = userEvent.setup();
      let release: (r: Response) => void = () => {};
      const { fetchMock } = mockFetch({
        "GET /api/sessions/:id/browser": () => new Promise<Response>((r) => (release = r)),
        "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE_ON),
      });
      vi.stubGlobal("fetch", fetchMock);
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(screen.getByText("Loading…")).toBeInTheDocument();
      await act(async () => release(jsonResponse(200, [{ sessionId: 5 }])));
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
    });
  });

  describe("the session (decision 4)", () => {
    it("fixes the focused session at the switch and keeps it when focus moves", async () => {
      const user = userEvent.setup();
      bindings[5] = [{ sessionId: 5 }];
      bindings[6] = [{ sessionId: 6 }];
      const { panel } = renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
      expect(panel.params.agentSessionId).toBe(5);

      act(() => useDashboardStore.setState({ activePanelId: "session-6" }));
      expect(screen.getByTestId("agent-5")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-6")).toBeNull();
      expect(agentRadio()).toHaveAccessibleName("Agent's browser · agent 5");
    });

    it("takes the last-focused session when focus already moved to the pane", async () => {
      const user = userEvent.setup();
      // Focus 6, then 5, then the pane itself: the store remembers 5.
      act(() => {
        useDashboardStore.getState().setActivePanelId("session-6");
        useDashboardStore.getState().setActivePanelId("session-5");
        useDashboardStore.getState().setActivePanelId("browser-1");
      });
      expect(useDashboardStore.getState().recentSessionIds).toEqual([5, 6]);
      bindings[5] = [{ sessionId: 5 }];
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser · agent 5/ }));
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
    });

    it("does not offer a focused session that has exited", async () => {
      useDashboardStore.setState({
        sessions: [session(5), session(7, { status: "exited" })],
        activePanelId: "session-7",
      });
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      expect(
        await screen.findByRole("radio", { name: "Agent's browser · agent 5" }),
      ).not.toHaveAttribute("aria-disabled");
    });

    it("takes the project's newest live session when none had focus", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ activePanelId: null });
      bindings[6] = [{ sessionId: 6 }];
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser · agent 6/ }));
      expect(await screen.findByTestId("agent-6")).toBeInTheDocument();
    });
  });

  describe("what the switch shows when something is missing", () => {
    it("has no switch when the browser feature is off", async () => {
      browserEnabled = false;
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      // Let the server-info request settle.
      await act(async () => {});
      expect(screen.getByTestId("preview")).toBeInTheDocument();
      expect(screen.queryByRole("radiogroup")).toBeNull();
    });

    it("comes back as Preview when a switched pane is restored with the feature off", async () => {
      browserEnabled = false;
      const { panel } = renderHost(
        "browser",
        { projectId: 1, mode: "agent", agentSessionId: 5 },
        "Browser · Agent's browser: agent 5",
      );
      expect(await screen.findByTestId("preview")).toBeInTheDocument();
      expect(panel.params.mode).toBe("preview");
      expect(probes).toEqual([]);
    });

    it("shows Preview for a restored agent's browser pane with the feature off", async () => {
      browserEnabled = false;
      const { panel } = renderHost(
        "browserPane",
        { sessionId: 5, mode: "agent" },
        "Browser · Agent's browser: agent 5",
      );
      expect(await screen.findByTestId("preview")).toBeInTheDocument();
      expect(screen.queryByTestId("agent-5")).toBeNull();
      expect(screen.queryByRole("radiogroup")).toBeNull();
      await waitFor(() => expect(panel.params.mode).toBe("preview"));
      // It was opened for this session's browser, so the pane says why.
      expect(useDashboardStore.getState().toasts.map((t) => t.message)).toEqual([
        "The agent's browser is off on this server (BROWSER_ENABLED), so this shows Preview.",
      ]);
    });

    it("disables Agent's browser when the project has no session", async () => {
      const user = userEvent.setup();
      useDashboardStore.setState({ sessions: [], activePanelId: null });
      renderHost("browser", { projectId: 1 }, "Browser · Preview: aurora");
      const agent = await screen.findByRole("radio", { name: /Agent's browser/ });
      expect(agent).toHaveAttribute("aria-disabled", "true");
      expect(agent).toHaveAttribute("title", "No session in this project");
      await user.click(agent);
      expect(previewRadio()).toHaveAttribute("aria-checked", "true");
      expect(probes).toEqual([]);
    });

    it("disables Agent's browser for a blank preview with no project", async () => {
      renderHost("browser", { kind: "external" }, "Browser · Preview");
      const agent = await screen.findByRole("radio", { name: /Agent's browser/ });
      expect(agent).toHaveAttribute("aria-disabled", "true");
      expect(agent).toHaveAttribute(
        "title",
        "Open a session's browser from the palette or its pane",
      );
    });

    it("treats an external preview that names a project as having one", async () => {
      renderHost("browser", { kind: "external", url: "https://x.dev", projectId: 1 }, "Docs");
      const agent = await screen.findByRole("radio", { name: /Agent's browser/ });
      expect(agent).not.toHaveAttribute("aria-disabled");
    });

    it("switches to Preview when the session is killed, and lets go of its browser", async () => {
      const { panel } = renderHost("browserPane", { sessionId: 5 }, "Agent Browser: agent 5");
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();

      act(() =>
        useDashboardStore.setState({ sessions: [session(5, { status: "killed" }), session(6)] }),
      );
      expect(screen.queryByTestId("agent-5")).toBeNull();
      expect(screen.getByTestId("preview")).toHaveAttribute(
        "data-params",
        JSON.stringify({ projectId: 1 }),
      );
      expect(panel.params.mode).toBe("preview");
      expect(panel.api.close).not.toHaveBeenCalled();
    });

    it("closes a pane with no project when its session is gone", async () => {
      useDashboardStore.setState({ sessions: [] });
      const { panel } = renderHost("browserPane", { sessionId: 42 }, "Agent Browser: x");
      await act(async () => {});
      expect(panel.api.close).toHaveBeenCalled();
    });

    it("keeps the switch next to a binding that is gone", async () => {
      // binding_unavailable is BrowserPane's own error state (its tests cover
      // it); the switch is in the same toolbar, so Preview stays reachable.
      const user = userEvent.setup();
      renderHost("browserPane", { sessionId: 5 }, "Agent Browser: agent 5");
      const pane = await screen.findByTestId("agent-5");
      // The switch shows once the server says the browser feature is on.
      expect(
        await within(pane).findByRole("radiogroup", { name: "Browser mode" }),
      ).toBeInTheDocument();
      await user.click(previewRadio());
      expect(screen.getByTestId("preview")).toBeInTheDocument();
    });
  });

  describe("titles (decision 5)", () => {
    it("names the mode in the pane title, and reads an old preview title", async () => {
      const user = userEvent.setup();
      bindings[5] = [{ sessionId: 5 }];
      const { panel } = renderHost("browser", { projectId: 1 }, "Preview · feat/x");
      expect(panel.api.title).toBe("Browser · Preview: feat/x");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(panel.api.title).toBe("Browser · Agent's browser: agent 5");
      await user.click(previewRadio());
      expect(panel.api.title).toBe("Browser · Preview: feat/x");
    });

    it("drops the Agent Browser title of an old layout", async () => {
      const { panel } = renderHost(
        "browserPane",
        { sessionId: 5 },
        "Agent Browser: Example Domain",
      );
      await screen.findByRole("radiogroup", { name: "Browser mode" });
      expect(panel.api.title).toBe("Browser · Agent's browser: agent 5");
      expect(panel.api.title).not.toMatch(/Agent Browser/);
    });
  });

  describe("saved layouts", () => {
    it("writes the mode to the panel params, so a reload keeps it", async () => {
      const user = userEvent.setup();
      bindings[5] = [{ sessionId: 5 }];
      const { panel, unmount } = renderHost("browser", { projectId: 1 }, "Preview: aurora");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(panel.params).toMatchObject({ mode: "agent", agentSessionId: 5, projectId: 1 });
      unmount();

      // The reload: the same component and params, no memory of the switch.
      renderHost("browser", panel.params, panel.api.title);
      expect(await screen.findByRole("radio", { name: /Agent's browser/ })).toHaveAttribute(
        "aria-checked",
        "true",
      );
      // A restored switch still asks before attaching.
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
      expect(probes).toEqual([5, 5]);
    });

    it("attaches on an explicit open even when the pane already shows Agent's browser", async () => {
      const user = userEvent.setup();
      const { panel } = renderHost("browserPane", { sessionId: 5, mode: "preview" }, "x");
      await user.click(await screen.findByRole("radio", { name: /Agent's browser/ }));
      expect(await screen.findByText("agent 5 has no browser yet.")).toBeInTheDocument();
      // The pane menu's "Open Agent Browser" again: the mode is already agent.
      act(() =>
        panel.api.updateParameters({ mode: "agent", agentSessionId: undefined, openRev: 1 }),
      );
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
    });

    it("follows an opener that asks for a mode on an open pane", async () => {
      const { panel } = renderHost("browserPane", { sessionId: 5, mode: "preview" }, "x");
      expect(await screen.findByTestId("preview")).toBeInTheDocument();
      act(() => panel.api.updateParameters({ mode: "agent", agentSessionId: undefined }));
      // The opener is an explicit open of this session's browser: no probe.
      expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
      expect(probes).toEqual([]);
    });
  });
});

const SERVER_INFO_FIXTURE_ON = {
  ...SERVER_INFO_FIXTURE,
  features: { ...SERVER_INFO_FIXTURE.features, browser: true },
};

// The panel registry is what a saved layout reaches: both old components
// load the one Browser pane, each in its own mode, without anything reading
// the layout blob.
describe("panel registry — both browser components load the Browser pane (#3371)", () => {
  beforeEach(() => {
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": () => jsonResponse(200, []),
      "GET /api/server-info": () => jsonResponse(200, SERVER_INFO_FIXTURE_ON),
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({
      projects: [makeProject({ id: 1, name: "aurora" })],
      sessions: [session(5)],
      sessionsLoaded: true,
      activePanelId: null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function props(params: BrowserHostParams, title: string) {
    const api = {
      title,
      setTitle: vi.fn(),
      close: vi.fn(),
      updateParameters: vi.fn(),
    };
    return { params, api, containerApi: {} } as unknown as IDockviewPanelProps<BrowserHostParams>;
  }

  it("opens a `browser` panel in Preview", async () => {
    const Wrapper = components.browser;
    render(<Wrapper {...props({ projectId: 1 }, "Preview: aurora")} />);
    expect(await screen.findByTestId("preview")).toBeInTheDocument();
    expect(screen.queryByTestId("agent-5")).toBeNull();
  });

  it("opens a `browserPane-<id>` panel in Agent's browser", async () => {
    const Wrapper = components.browserPane;
    render(<Wrapper {...props({ sessionId: 5 }, "Agent Browser: agent 5")} />);
    expect(await screen.findByTestId("agent-5")).toBeInTheDocument();
    expect(screen.queryByTestId("preview")).toBeNull();
  });
});

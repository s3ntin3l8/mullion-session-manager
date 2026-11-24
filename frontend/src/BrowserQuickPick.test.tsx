// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewPanelApi } from "dockview-react";
import type * as layoutTierModule from "./lib/layoutTier.js";
import { BrowserPaneHost } from "./BrowserPaneHost.js";
import type { BrowserHostComponent, BrowserHostParams } from "./BrowserPaneHost.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import { BrowserQuickPick } from "./BrowserQuickPick.js";
import type { QuickPickEntry } from "./BrowserQuickPick.js";
import type { PreviewSource } from "./lib/browserHandoff.js";
import { HANDOFF_PROXY_ADDRESS } from "./lib/browserHandoff.js";
import {
  MAX_BROWSER_RECENTS,
  readBrowserRecents,
  recordBrowserRecent,
} from "./lib/browserRecents.js";
import type { BrowserDestination, Session } from "./api/index.js";
import { useDashboardStore } from "./store/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject, makeServerInfo, makeSession } from "./test/fixtures.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";

// #3003 — the Browser pane's quick pick: its list (three groups, in the
// owner's order), and what a pick opens in each mode, through the grid pane.
// The engines are stand-ins, as in BrowserHandoff.test.tsx: the preview
// reports its params, the agent's browser the navigation it was asked for.
let coarse = false;
vi.mock("./lib/layoutTier.js", async (importOriginal) => ({
  ...(await importOriginal<typeof layoutTierModule>()),
  useCoarsePointer: () => coarse,
}));

let agentProps: { navigateTo?: { url: string; rev: number } } | null = null;

function sourceOf(params: BrowserPanelParams): PreviewSource | null {
  if (params.kind === "external") return params.url ? { kind: "address", url: params.url } : null;
  return params.previewSlug ? { kind: "project", slug: params.previewSlug } : { kind: "project" };
}

vi.mock("./BrowserPanel.js", () => ({
  BrowserPanel: (props: {
    params: BrowserPanelParams;
    toolbarStart?: ReactNode;
    addressEnd?: ReactNode;
    onSourceChange?: (s: PreviewSource | null) => void;
  }) => {
    const { onSourceChange, params } = props;
    useEffect(() => {
      onSourceChange?.(sourceOf(params));
    }, [onSourceChange, params]);
    return (
      <div data-testid="preview" data-params={JSON.stringify(props.params)}>
        {props.toolbarStart}
        {props.addressEnd}
      </div>
    );
  },
}));
vi.mock("./BrowserPane.js", () => ({
  BrowserPane: (props: {
    params: { sessionId: number };
    toolbarStart?: ReactNode;
    addressEnd?: ReactNode;
    navigateTo?: { url: string; rev: number };
  }) => {
    agentProps = { navigateTo: props.navigateTo };
    return (
      <div
        data-testid={`agent-${props.params.sessionId}`}
        data-navigate={props.navigateTo?.url ?? ""}
      >
        {props.toolbarStart}
        {props.addressEnd}
      </div>
    );
  },
}));

const destination = (over: Partial<BrowserDestination>): BrowserDestination => ({
  key: "dev-server",
  group: "saved",
  kind: "dev-server",
  label: "Dev server",
  detail: "5173",
  address: "http://localhost:5173/",
  hostId: "local",
  previewSlug: null,
  targetId: null,
  ...over,
});

const DESTINATIONS: BrowserDestination[] = [
  destination({
    key: "dock:7",
    group: "running",
    kind: "dock",
    label: "storybook",
    detail: "Dock · port 6006",
    address: "http://localhost:6006/",
  }),
  destination({
    key: "compose:shop:web:8080",
    group: "running",
    kind: "compose",
    label: "web",
    detail: "shop · port 8080",
    address: "http://localhost:8080/",
  }),
  destination({}),
  destination({
    key: "target:docs",
    kind: "target",
    label: "API docs",
    detail: "localhost:9000/docs",
    address: "http://localhost:9000/docs",
    targetId: "docs",
  }),
  destination({
    key: "branch:b-slug",
    kind: "branch",
    label: "feat/cart",
    detail: "Branch preview",
    address: "http://localhost:4100/",
    previewSlug: "b-slug",
  }),
];

const trigger = () =>
  screen.getByRole("button", { name: "Quick pick: running services, saved and recent pages" });
const list = () => screen.getByRole("group", { name: "Open in this browser" });
const queryList = () => screen.queryByRole("group", { name: "Open in this browser" });
const item = (name: RegExp | string) => within(list()).getByRole("button", { name });

describe("BrowserQuickPick (#3003)", () => {
  let previewsEnabled: boolean;
  let requests: string[];
  let runningNote: string | null;
  let agentHost: string | null;

  beforeEach(() => {
    coarse = false;
    previewsEnabled = true;
    requests = [];
    runningNote = null;
    agentHost = "local";
    agentProps = null;
    localStorage.clear();
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/browser-destinations": ({ url, query }) => {
        requests.push(`GET ${url}`);
        return jsonResponse(200, {
          destinations: DESTINATIONS,
          runningNote,
          agentBrowser: query.has("sessionId")
            ? { hostId: agentHost, reason: agentHost ? null : "The host is unreachable" }
            : null,
        });
      },
      "POST /api/projects/:id/browser-destinations/preview": ({ url, init }) => {
        requests.push(`POST ${url} ${String(init?.body)}`);
        return jsonResponse(200, { slug: "port-slug", label: "storybook" });
      },
      "POST /api/previews": ({ init }) => {
        requests.push(`POST /api/previews ${String(init?.body)}`);
        return jsonResponse(201, { slug: "target-slug", kind: "target", projectId: 1 });
      },
      "GET /api/sessions/:id/browser": () => jsonResponse(200, [{ id: 1 }]),
      "GET /api/sessions/:id/browser/address-for-preview": () =>
        jsonResponse(200, { ok: true, url: "http://localhost:5173/" }),
      "POST /api/sessions/:id/browser/preview-for-address": () =>
        jsonResponse(200, { kind: "external", url: "https://example.com/" }),
      "GET /api/server-info": () =>
        jsonResponse(
          200,
          makeServerInfo({
            previewsEnabled,
            previewBaseHost: previewsEnabled ? "preview.test" : "",
            features: { ...makeServerInfo().features, browser: true },
          }),
        ),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("the list", () => {
    function renderList(props: Partial<Parameters<typeof BrowserQuickPick>[0]> = {}): {
      onPick: ReturnType<typeof vi.fn>;
    } {
      const onPick = vi.fn();
      render(
        <BrowserQuickPick
          projectId={1}
          mode="preview"
          refusal={() => null}
          onPick={onPick}
          {...props}
        />,
      );
      return { onPick };
    }

    it("lists running now, then saved, then recent, each in order", async () => {
      recordBrowserRecent("preview", "https://example.com/");
      renderList();
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/storybook/)).toBeInTheDocument());
      const groups = within(list())
        .getAllByRole("group")
        .map((g) => ({
          title: g.getAttribute("aria-label"),
          items: within(g)
            .queryAllByRole("button")
            .map((i) => i.querySelector(".browser-quick-pick-label")?.textContent),
        }));
      expect(groups).toEqual([
        { title: "Running now", items: ["storybook", "web"] },
        { title: "Saved", items: ["Dev server", "API docs", "feat/cart"] },
        { title: "Recent", items: ["https://example.com/"] },
      ]);
      expect(item(/web/)).toHaveTextContent("shop · port 8080");
      expect(requests).toEqual(["GET /api/projects/1/browser-destinations"]);
    });

    it("reports a pick with the server's proxy setting, and closes", async () => {
      const { onPick } = renderList();
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/storybook/)).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(item(/storybook/));
      expect(onPick).toHaveBeenCalledWith(
        expect.objectContaining({ source: "destination" }) as QuickPickEntry,
        { previewsEnabled: true, agentHostId: null, agentHostReason: null },
      );
      expect(queryList()).toBeNull();
    });

    it("shows why an entry cannot open, and does not pick it", async () => {
      const { onPick } = renderList({
        refusal: (e) =>
          e.source === "destination" && e.destination.kind === "target" ? "Needs the proxy" : null,
      });
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/API docs/)).toHaveAttribute("aria-disabled", "true"));
      expect(item(/API docs/)).toHaveTextContent("Needs the proxy");
      await userEvent.click(item(/API docs/));
      expect(onPick).not.toHaveBeenCalled();
    });

    it("says why a remote project has no running services", async () => {
      runningNote = "Running services are detected only for projects on this server, not on box-a.";
      renderList();
      await userEvent.click(trigger());
      await waitFor(() =>
        expect(within(screen.getByRole("group", { name: "Running now" })).getByText(/box-a/)),
      );
    });

    it("lists recent addresses only, without asking the server, for a pane with no project", async () => {
      recordBrowserRecent("agent", "https://docs.example.com/");
      renderList({ projectId: null, mode: "agent" });
      await userEvent.click(trigger());
      expect(
        within(list())
          .getAllByRole("group")
          .map((g) => g.getAttribute("aria-label")),
      ).toEqual(["Recent"]);
      expect(item("https://docs.example.com/")).toBeInTheDocument();
      expect(requests).toEqual([]);
    });

    it("says so when the list cannot load", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          "GET /api/projects/:id/browser-destinations": () =>
            jsonResponse(500, { message: "boom" }),
          "GET /api/server-info": () => jsonResponse(500, {}),
        }).fetchMock,
      );
      renderList();
      await userEvent.click(trigger());
      await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    });

    it("closes on Escape and on a click outside", async () => {
      renderList();
      await userEvent.click(trigger());
      expect(list()).toBeInTheDocument();
      await userEvent.keyboard("{Escape}");
      expect(queryList()).toBeNull();
      await userEvent.click(trigger());
      await userEvent.click(document.body);
      expect(queryList()).toBeNull();
    });

    it("closes when the pane moves to another project or mode", async () => {
      const props = { refusal: () => null, onPick: vi.fn() };
      const { rerender } = render(<BrowserQuickPick projectId={1} mode="preview" {...props} />);
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/storybook/)).toBeInTheDocument());
      rerender(<BrowserQuickPick projectId={2} mode="preview" {...props} />);
      expect(queryList()).toBeNull();
      await userEvent.click(trigger());
      expect(list()).toBeInTheDocument();
      rerender(<BrowserQuickPick projectId={2} mode="agent" {...props} />);
      expect(queryList()).toBeNull();
    });

    it("opens as a sheet under a coarse pointer", async () => {
      coarse = true;
      renderList();
      await userEvent.click(trigger());
      const sheet = await screen.findByRole("dialog", { name: "Open in this browser" });
      await waitFor(() => expect(within(sheet).getByText("storybook")).toBeInTheDocument());
      expect(sheet).toHaveClass("browser-quick-pick-sheet");
    });
  });

  describe("recent addresses", () => {
    it("keeps each mode's own, newest first, capped, and never a proxy address", () => {
      for (let i = 0; i < MAX_BROWSER_RECENTS + 2; i++) {
        recordBrowserRecent("preview", `https://site${i}.example/`);
      }
      recordBrowserRecent("preview", "https://site3.example/");
      recordBrowserRecent("preview", "https://preview-abc.preview.test/?__mullion_preview=t");
      recordBrowserRecent("preview", "ftp://example.com/");
      const list = readBrowserRecents("preview");
      expect(list).toHaveLength(MAX_BROWSER_RECENTS);
      expect(list[0]).toBe("https://site3.example/");
      expect(list.some((u) => u.includes("preview-abc"))).toBe(false);
      expect(readBrowserRecents("agent")).toEqual([]);
    });

    it("ignores a stored value of the wrong shape", () => {
      localStorage.setItem("crs.browserRecents", JSON.stringify({ preview: [1, "https://a/"] }));
      expect(readBrowserRecents("preview")).toEqual(["https://a/"]);
      localStorage.setItem("crs.browserRecents", JSON.stringify(["x"]));
      expect(readBrowserRecents("preview")).toEqual([]);
    });
  });

  describe("picking, through the Browser pane", () => {
    const session = (id: number, over: Partial<Session> = {}) =>
      makeSession({ id, projectId: 1, name: `agent ${id}`, nameLocked: true, ...over });

    function renderHost(component: BrowserHostComponent, initial: BrowserHostParams) {
      let params = initial;
      let rerender: (() => void) | null = null;
      const api = {
        title: "",
        setTitle: vi.fn((t: string) => {
          api.title = t;
        }),
        close: vi.fn(),
        updateParameters: vi.fn((patch: Record<string, unknown>) => {
          params = { ...params, ...patch } as BrowserHostParams;
          queueMicrotask(() => act(() => rerender?.()));
        }),
      };
      const ui = () => (
        <BrowserPaneHost
          params={params}
          api={api as unknown as DockviewPanelApi}
          component={component}
        />
      );
      const result = render(ui());
      rerender = () => result.rerender(ui());
      return {
        api,
        get params() {
          return params;
        },
      };
    }

    const previewParams = () =>
      JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}") as Record<
        string,
        unknown
      >;

    beforeEach(() => {
      resetStore({
        projects: [makeProject({ id: 1, name: "aurora" })],
        sessions: [session(5)],
        sessionsLoaded: true,
        activePanelId: "session-5",
      });
    });

    async function pick(name: RegExp | string) {
      await userEvent.click(trigger());
      await waitFor(() => expect(item(name)).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(item(name));
    }

    it("opens a running service in the preview through the proxy", async () => {
      const host = renderHost("browser", { projectId: 1 });
      await pick(/storybook/);
      await waitFor(() => expect(previewParams().previewSlug).toBe("port-slug"));
      expect(requests).toContain(
        'POST /api/projects/1/browser-destinations/preview {"key":"dock:7"}',
      );
      await waitFor(() => expect(host.api.title).toBe("Browser · Preview: storybook"));
    });

    it("opens a running service at its own address without the proxy", async () => {
      previewsEnabled = false;
      renderHost("browser", { projectId: 1 });
      await pick(/web/);
      await waitFor(() =>
        expect(previewParams()).toMatchObject({ kind: "external", url: "http://localhost:8080/" }),
      );
      expect(requests.some((r) => r.startsWith("POST"))).toBe(false);
    });

    it("refuses named targets and branch previews without the proxy", async () => {
      previewsEnabled = false;
      renderHost("browser", { projectId: 1 });
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/API docs/)).toHaveAttribute("aria-disabled", "true"));
      expect(item(/API docs/)).toHaveTextContent("PREVIEW_BASE_HOST");
      expect(item(/feat\/cart/)).toHaveAttribute("aria-disabled", "true");
    });

    it("opens a named target's preview, a branch preview and the dev server", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "https://example.com/" });
      await pick(/API docs/);
      await waitFor(() =>
        expect(previewParams()).toMatchObject({
          previewSlug: "target-slug",
          targetName: "API docs",
        }),
      );
      expect(requests).toContain(
        'POST /api/previews {"kind":"target","projectId":1,"targetId":"docs"}',
      );
      await pick(/feat\/cart/);
      await waitFor(() => expect(previewParams().previewSlug).toBe("b-slug"));
      await pick(/Dev server/);
      await waitFor(() => expect(previewParams().previewSlug).toBeUndefined());
      expect(previewParams().kind).toBeUndefined();
    });

    it("opens a recent address in the preview", async () => {
      recordBrowserRecent("preview", "https://docs.example.com/");
      renderHost("browser", { projectId: 1 });
      await pick("https://docs.example.com/");
      await waitFor(() =>
        expect(previewParams()).toMatchObject({
          kind: "external",
          url: "https://docs.example.com/",
        }),
      );
    });

    it("loads an entry's own address in the agent's browser", async () => {
      renderHost("browserPane", { sessionId: 5 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      await pick(/storybook/);
      await waitFor(() => expect(agentProps?.navigateTo?.url).toBe("http://localhost:6006/"));
      expect(requests.some((r) => r.startsWith("POST"))).toBe(false);
    });

    it("refuses, in the agent's browser, a localhost entry on another host than the session's browser", async () => {
      // The server says where the browser runs (its binding first), whatever
      // host the session row names.
      agentHost = "box-a";
      useDashboardStore.setState({ sessions: [session(5, { hostId: null })] });
      renderHost("browserPane", { sessionId: 5 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/storybook/)).toHaveAttribute("aria-disabled", "true"));
      expect(item(/storybook/)).toHaveTextContent("another host");
      expect(requests).toContain("GET /api/projects/1/browser-destinations?sessionId=5");
    });

    it("loads a localhost entry when the session's browser runs on its host, wherever the session runs", async () => {
      agentHost = "local";
      useDashboardStore.setState({ sessions: [session(5, { hostId: "box-a" })] });
      renderHost("browserPane", { sessionId: 5 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      await pick(/storybook/);
      await waitFor(() => expect(agentProps?.navigateTo?.url).toBe("http://localhost:6006/"));
    });

    it("refuses localhost entries with the server's reason when it cannot tell the browser's host", async () => {
      agentHost = null;
      renderHost("browserPane", { sessionId: 5 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/storybook/)).toHaveTextContent("The host is unreachable"));
    });

    it("refuses a proxy address in the agent's browser", async () => {
      recordBrowserRecent("agent", "https://example.com/?__mullion_preview=t");
      // Not kept at all; a destination carrying one is refused instead.
      expect(readBrowserRecents("agent")).toEqual([]);
      vi.stubGlobal(
        "fetch",
        mockFetch({
          "GET /api/projects/:id/browser-destinations": () =>
            jsonResponse(200, {
              destinations: [
                destination({
                  key: "target:p",
                  kind: "target",
                  label: "Proxied",
                  address: "https://preview-x.preview.test/",
                  targetId: "p",
                }),
              ],
              runningNote: null,
            }),
          "GET /api/sessions/:id/browser": () => jsonResponse(200, [{ id: 1 }]),
          "POST /api/sessions/:id/browser/preview-for-address": () =>
            jsonResponse(200, { kind: "external", url: "https://example.com/" }),
          "GET /api/server-info": () =>
            jsonResponse(
              200,
              makeServerInfo({ features: { ...makeServerInfo().features, browser: true } }),
            ),
        }).fetchMock,
      );
      renderHost("browserPane", { sessionId: 5 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      await userEvent.click(trigger());
      await waitFor(() => expect(item(/Proxied/)).toHaveTextContent(HANDOFF_PROXY_ADDRESS));
    });

    it("records what the preview opened as a recent address of that mode", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "https://seen.example/" });
      await waitFor(() => expect(readBrowserRecents("preview")).toEqual(["https://seen.example/"]));
      expect(readBrowserRecents("agent")).toEqual([]);
    });
  });
});

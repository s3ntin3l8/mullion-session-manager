// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { ReactNode } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewPanelApi } from "dockview-react";
import { BrowserPaneHost } from "./BrowserPaneHost.js";
import type { BrowserHostComponent, BrowserHostParams } from "./BrowserPaneHost.js";
import type { BrowserPanelParams } from "./BrowserPanel.js";
import type { PreviewSource } from "./lib/browserHandoff.js";
import {
  HANDOFF_FAILED,
  HANDOFF_LOOPBACK,
  HANDOFF_NOT_HTTP,
  HANDOFF_NO_AGENT_PAGE,
  HANDOFF_PENDING,
  previewResetPatch,
} from "./lib/browserHandoff.js";
import type { Session } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject, makeSession } from "./test/fixtures.js";
import { mockFetch } from "./test/mockFetch.js";
import { resetStore } from "./test/resetStore.js";
import { SERVER_INFO_FIXTURE } from "./test/serverInfoFixture.js";

// #3373 — the Browser pane's ⇄ button, through the grid's pane. Both engines
// are stand-ins: the preview reports what it loaded the way BrowserPanel does
// (by params, never by its iframe's address), and the agent's browser exposes
// the page address it would report and the navigation it was asked for.
// BrowserPanel's and BrowserPane's own halves are tested in their files.
let agentProps: {
  sessionId: number;
  onUrlChange?: (url: string) => void;
  navigateTo?: { url: string; rev: number };
} | null = null;
let previewProps: {
  params: BrowserPanelParams;
  onShowInAgentBrowser?: () => void;
} | null = null;

function sourceOf(params: BrowserPanelParams): PreviewSource | null {
  if (params.kind === "external") return params.url ? { kind: "address", url: params.url } : null;
  return params.previewSlug ? { kind: "project", slug: params.previewSlug } : { kind: "project" };
}

vi.mock("./BrowserPanel.js", () => ({
  BrowserPanel: (props: {
    params: BrowserPanelParams;
    toolbarStart?: ReactNode;
    toolbarEnd?: ReactNode;
    onSourceChange?: (s: PreviewSource | null) => void;
    onShowInAgentBrowser?: () => void;
  }) => {
    previewProps = props;
    const { onSourceChange, params } = props;
    useEffect(() => {
      onSourceChange?.(sourceOf(params));
    }, [onSourceChange, params]);
    return (
      <div data-testid="preview" data-params={JSON.stringify(props.params)}>
        <div className="browser-panel-toolbar">
          {props.toolbarStart}
          {props.toolbarEnd}
        </div>
      </div>
    );
  },
}));
vi.mock("./BrowserPane.js", () => ({
  BrowserPane: (props: {
    params: { sessionId: number };
    toolbarStart?: ReactNode;
    toolbarEnd?: ReactNode;
    onUrlChange?: (url: string) => void;
    navigateTo?: { url: string; rev: number };
  }) => {
    agentProps = {
      sessionId: props.params.sessionId,
      onUrlChange: props.onUrlChange,
      navigateTo: props.navigateTo,
    };
    return (
      <div
        data-testid={`agent-${props.params.sessionId}`}
        data-navigate={props.navigateTo?.url ?? ""}
      >
        <div className="browser-panel-toolbar">
          {props.toolbarStart}
          {props.toolbarEnd}
        </div>
      </div>
    );
  },
}));

const session = (id: number, over: Partial<Session> = {}) =>
  makeSession({ id, projectId: 1, name: `agent ${id}`, nameLocked: true, ...over });

function makePanelApi() {
  let params: BrowserHostParams = {};
  let rerender: (() => void) | null = null;
  const api = {
    title: "",
    setTitle: vi.fn((t: string) => {
      api.title = t;
    }),
    close: vi.fn(),
    updateParameters: vi.fn((patch: Record<string, unknown>) => {
      const next: Record<string, unknown> = { ...params, ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete next[k];
      params = next as BrowserHostParams;
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

function renderHost(component: BrowserHostComponent, params: BrowserHostParams) {
  const panel = makePanelApi();
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
  return { ...result, panel };
}

const toAgent = () => screen.getByRole("button", { name: "Open in the agent's browser" });
const toPreview = () => screen.getByRole("button", { name: "Open in the preview" });
const modeOf = () =>
  within(screen.getByRole("radiogroup", { name: "Browser mode" }))
    .getAllByRole("radio")
    .find((r) => r.getAttribute("aria-checked") === "true")?.textContent;

describe("open in the other browser (#3373)", () => {
  let requests: string[];
  let browserEnabled: boolean;
  let addressAnswer: (slug: string | null) => Response | Promise<Response>;
  let previewAnswer: (url: string) => Response | Promise<Response>;

  beforeEach(() => {
    requests = [];
    browserEnabled = true;
    agentProps = null;
    previewProps = null;
    addressAnswer = () => jsonResponse(200, { ok: true, url: "http://localhost:5173/" });
    previewAnswer = () => jsonResponse(200, { kind: "project", label: "", path: "/" });
    const { fetchMock } = mockFetch({
      "GET /api/sessions/:id/browser": () => jsonResponse(200, [{ id: 1 }]),
      "GET /api/sessions/:id/browser/address-for-preview": ({ url, query }) => {
        requests.push(url);
        return addressAnswer(query.get("slug"));
      },
      "GET /api/sessions/:id/browser/preview-for-address": ({ url, query }) => {
        requests.push(url);
        return previewAnswer(query.get("url") ?? "");
      },
      "POST /api/previews": ({ init }) => {
        requests.push(`POST ${String(init?.body)}`);
        return jsonResponse(200, { slug: "target-slug", kind: "target", projectId: 1 });
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
      sessions: [session(5)],
      sessionsLoaded: true,
      activePanelId: "session-5",
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("preview -> agent's browser", () => {
    it("asks the server for a project preview's address, then opens it and switches", async () => {
      const { panel } = renderHost("browser", { projectId: 1 });
      await waitFor(() =>
        expect(toAgent()).toHaveAttribute(
          "title",
          "Open http://localhost:5173/ in the agent's browser",
        ),
      );
      expect(requests).toEqual(["/api/sessions/5/browser/address-for-preview"]);
      await userEvent.click(toAgent());
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      expect(screen.getByTestId("agent-5")).toHaveAttribute(
        "data-navigate",
        "http://localhost:5173/",
      );
      expect(modeOf()).toMatch(/Agent's browser/);
      await waitFor(() => expect(panel.params.mode).toBe("agent"));
    });

    it("names a branch preview by slug, so the iframe's address and token never travel", async () => {
      addressAnswer = (slug) =>
        jsonResponse(200, { ok: true, url: `http://localhost:4100/?for=${slug}` });
      renderHost("browser", { projectId: 1, previewSlug: "feat-x-slug" });
      await waitFor(() => expect(toAgent().getAttribute("title")).toContain("for=feat-x-slug"));
      expect(requests).toEqual(["/api/sessions/5/browser/address-for-preview?slug=feat-x-slug"]);
      expect(requests.join(" ")).not.toContain("__mullion_preview");
      await userEvent.click(toAgent());
      await waitFor(() =>
        expect(agentProps?.navigateTo?.url).toBe("http://localhost:4100/?for=feat-x-slug"),
      );
      expect(agentProps?.navigateTo?.url).not.toContain("__mullion_preview");
    });

    it("sends an external address as is, without asking the server", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "https://example.com/a?b=1" });
      await waitFor(() =>
        expect(toAgent()).toHaveAttribute(
          "title",
          "Open https://example.com/a?b=1 in the agent's browser",
        ),
      );
      await userEvent.click(toAgent());
      await waitFor(() =>
        expect(screen.getByTestId("agent-5")).toHaveAttribute(
          "data-navigate",
          "https://example.com/a?b=1",
        ),
      );
      expect(requests).toEqual([]);
    });

    it("is disabled for an address that is not http or https", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "ftp://example.com/" });
      await waitFor(() => expect(toAgent()).toHaveAttribute("title", HANDOFF_NOT_HTTP));
      expect(toAgent()).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(toAgent());
      expect(modeOf()).toBe("Preview");
      expect(screen.queryByTestId("agent-5")).toBeNull();
    });

    it("is disabled for a localhost address, which is a different machine to each engine", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "http://localhost:3000/" });
      await waitFor(() => expect(toAgent()).toHaveAttribute("title", HANDOFF_LOOPBACK));
      expect(toAgent()).toHaveAttribute("aria-disabled", "true");
      // Not offered in the "unavailable" state either.
      expect(previewProps?.onShowInAgentBrowser).toBeUndefined();
    });

    it("shows the server's reason when the agent's browser cannot reach the preview", async () => {
      addressAnswer = () =>
        jsonResponse(200, { ok: false, reason: "The dev server runs on box-a, and ..." });
      renderHost("browser", { projectId: 1 });
      await waitFor(() =>
        expect(toAgent()).toHaveAttribute("title", "The dev server runs on box-a, and ..."),
      );
      expect(toAgent()).toHaveAttribute("aria-disabled", "true");
    });

    it("fails closed while the server has not answered, and when it errors", async () => {
      let release: (r: Response) => void = () => {};
      addressAnswer = () => new Promise<Response>((r) => (release = r));
      renderHost("browser", { projectId: 1 });
      await waitFor(() => expect(toAgent()).toHaveAttribute("title", HANDOFF_PENDING));
      expect(toAgent()).toHaveAttribute("aria-disabled", "true");
      await act(async () => release(jsonResponse(500, { message: "boom" })));
      await waitFor(() => expect(toAgent()).toHaveAttribute("title", HANDOFF_FAILED));
    });

    it("is disabled with the switch's reason when the project has no session", async () => {
      resetStore({
        projects: [makeProject({ id: 1, name: "aurora" })],
        sessions: [],
        sessionsLoaded: true,
      });
      renderHost("browser", { projectId: 1 });
      await waitFor(() => expect(toAgent()).toHaveAttribute("title", "No session in this project"));
      expect(requests).toEqual([]);
    });

    it("offers the external preview's unavailable state a way to the agent's browser", async () => {
      renderHost("browser", { projectId: 1, kind: "external", url: "https://example.com/" });
      await waitFor(() => expect(previewProps?.onShowInAgentBrowser).toBeDefined());
      act(() => previewProps?.onShowInAgentBrowser?.());
      await waitFor(() =>
        expect(screen.getByTestId("agent-5")).toHaveAttribute(
          "data-navigate",
          "https://example.com/",
        ),
      );
    });

    it("has no ⇄ without the browser feature", async () => {
      browserEnabled = false;
      renderHost("browser", { projectId: 1, kind: "external", url: "https://example.com/" });
      await waitFor(() => expect(screen.getByTestId("preview")).toBeInTheDocument());
      await act(async () => {});
      expect(screen.queryByRole("button", { name: /Open in the agent's browser/ })).toBeNull();
    });
  });

  describe("agent's browser -> preview", () => {
    async function openAgent(page: string | null) {
      const utils = renderHost("browserPane", { sessionId: 5, projectId: 1 });
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      if (page != null) act(() => agentProps?.onUrlChange?.(page));
      return utils;
    }

    it("opens one of the project's dev servers through the proxy, with the page's path", async () => {
      previewAnswer = () => jsonResponse(200, { kind: "project", label: "", path: "/a?b=1" });
      const { panel } = await openAgent("http://localhost:5173/a?b=1");
      await waitFor(() =>
        expect(toPreview()).toHaveAttribute(
          "title",
          "Open http://localhost:5173/a?b=1 in the preview",
        ),
      );
      expect(requests).toEqual([
        `/api/sessions/5/browser/preview-for-address?url=${encodeURIComponent("http://localhost:5173/a?b=1")}`,
      ]);
      await userEvent.click(toPreview());
      await waitFor(() => expect(modeOf()).toBe("Preview"));
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params).toMatchObject({ projectId: 1, previewPath: "/a?b=1" });
      expect(params.kind).toBeUndefined();
      await waitFor(() => expect(panel.api.title).toBe("Browser · Preview: aurora"));
    });

    it("opens a branch preview by its slug", async () => {
      previewAnswer = () =>
        jsonResponse(200, { kind: "project", previewSlug: "br", label: "feat-x", path: "/" });
      const { panel } = await openAgent("http://localhost:4100/");
      await waitFor(() => expect(toPreview()).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(toPreview());
      await waitFor(() => expect(modeOf()).toBe("Preview"));
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params).toMatchObject({ projectId: 1, previewSlug: "br" });
      expect(params.previewPath).toBeUndefined();
      await waitFor(() => expect(panel.api.title).toBe("Browser · Preview: feat-x"));
      await waitFor(() => expect(panel.params.previewTarget).toBe("feat-x"));
    });

    it("opens a named preview target, creating its preview first", async () => {
      previewAnswer = () =>
        jsonResponse(200, { kind: "project", targetId: "t1", label: "Admin", path: "/x" });
      await openAgent("http://localhost:9000/x");
      await waitFor(() => expect(toPreview()).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(toPreview());
      await waitFor(() => expect(modeOf()).toBe("Preview"));
      expect(requests).toContain(
        `POST ${JSON.stringify({ kind: "target", projectId: 1, targetId: "t1" })}`,
      );
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params).toMatchObject({
        projectId: 1,
        previewSlug: "target-slug",
        targetName: "Admin",
        previewPath: "/x",
      });
    });

    it("opens any other page as an external address, keeping the project", async () => {
      previewAnswer = (url) => jsonResponse(200, { kind: "external", url });
      const { panel } = await openAgent("https://example.com/docs");
      await waitFor(() => expect(toPreview()).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(toPreview());
      await waitFor(() => expect(modeOf()).toBe("Preview"));
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params).toMatchObject({
        projectId: 1,
        kind: "external",
        url: "https://example.com/docs",
      });
      await waitFor(() => expect(panel.api.title).toBe("Browser · Preview: example.com"));
      // The pane keeps its project, so ⇄ and the switch stay usable.
      await waitFor(() =>
        expect(toAgent()).toHaveAttribute(
          "title",
          "Open https://example.com/docs in the agent's browser",
        ),
      );
    });

    it("is disabled, with the server's reason, for a localhost page that is no dev server", async () => {
      previewAnswer = () =>
        jsonResponse(200, {
          kind: "disabled",
          reason: "localhost:6000 is not one of this project's dev servers, ...",
        });
      await openAgent("http://localhost:6000/");
      await waitFor(() =>
        expect(toPreview()).toHaveAttribute(
          "title",
          "localhost:6000 is not one of this project's dev servers, ...",
        ),
      );
      await userEvent.click(toPreview());
      expect(modeOf()).toMatch(/Agent's browser/);
    });

    it("never asks about a page that is not http or https", async () => {
      await openAgent("about:blank");
      await waitFor(() => expect(toPreview()).toHaveAttribute("title", HANDOFF_NO_AGENT_PAGE));
      expect(requests).toEqual([]);
    });

    it("round-trips: preview -> agent -> preview lands on the project's own preview", async () => {
      renderHost("browser", { projectId: 1 });
      await waitFor(() => expect(toAgent()).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(toAgent());
      await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
      act(() => agentProps?.onUrlChange?.("http://localhost:5173/"));
      await waitFor(() => expect(toPreview()).not.toHaveAttribute("aria-disabled"));
      await userEvent.click(toPreview());
      await waitFor(() => expect(modeOf()).toBe("Preview"));
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params).toMatchObject({ projectId: 1 });
      expect(params.kind).toBeUndefined();
      expect(params.previewSlug).toBeUndefined();
    });
  });

  it("an opener's reset drops what ⇄ opened in the preview", async () => {
    previewAnswer = (url) => jsonResponse(200, { kind: "external", url });
    const { panel } = renderHost("browserPane", { sessionId: 5, projectId: 1 });
    await waitFor(() => expect(screen.getByTestId("agent-5")).toBeInTheDocument());
    act(() => agentProps?.onUrlChange?.("https://example.com/"));
    await waitFor(() => expect(toPreview()).not.toHaveAttribute("aria-disabled"));
    await userEvent.click(toPreview());
    await waitFor(() => expect(modeOf()).toBe("Preview"));

    // What onOpenBrowser does to the project's pane.
    const reset = previewResetPatch(panel.params, { projectId: 1 });
    expect(reset).not.toBeNull();
    act(() => panel.api.updateParameters({ ...reset, mode: "preview" }));
    await waitFor(() => {
      const params = JSON.parse(screen.getByTestId("preview").getAttribute("data-params") ?? "{}");
      expect(params.kind).toBeUndefined();
      expect(params.url).toBeUndefined();
    });
    await waitFor(() => expect(panel.api.title).toBe("Browser · Preview: aurora"));
  });

  it("previewResetPatch leaves a pane that shows its own target alone", () => {
    expect(previewResetPatch({ projectId: 1 }, { projectId: 1 })).toBeNull();
    expect(
      previewResetPatch({ projectId: 1, previewSlug: "s" }, { projectId: 1, previewSlug: "s" }),
    ).toBeNull();
    expect(previewResetPatch(undefined, { projectId: 1 })).toBeNull();
    expect(previewResetPatch({ projectId: 1, previewPath: "/a" }, { projectId: 1 })).toMatchObject({
      previewPath: undefined,
      kind: undefined,
    });
  });
});

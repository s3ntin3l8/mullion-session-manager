// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserPanel } from "./BrowserPanel.js";
import { useDashboardStore } from "./store/index.js";
import { api } from "./api/index.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject } from "./test/fixtures.js";
import { SERVER_INFO_FIXTURE } from "./test/serverInfoFixture.js";

const PROJECT = makeProject({ id: 1, name: "mullion", devServerUrl: "5173" });
const SERVER_INFO_BASE = SERVER_INFO_FIXTURE;

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

// #3373 — what the preview reports to the Browser pane's ⇄ button, and the
// way to the agent's browser from an external preview that cannot load.
describe("open in the other browser (#3373)", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDevServerStatus").mockResolvedValue({ online: true });
    stubMatchMedia(false);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useDashboardStore.setState({ projects: [], sessions: [] });
  });

  function stubProxy(opts: { token?: boolean; externalStatus?: number } = {}) {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/1/urls") return Promise.resolve(jsonResponse(200, []));
      if (url === "/api/browser-urls/favorites") return Promise.resolve(jsonResponse(200, []));
      if (url === "/api/server-info") {
        return Promise.resolve(
          jsonResponse(200, {
            ...SERVER_INFO_BASE,
            previewsEnabled: true,
            previewBaseHost: "preview.example.com",
            previewAuthRequired: opts.token ?? false,
          }),
        );
      }
      if (url === "/api/previews" && method === "POST") {
        const body = JSON.parse(String(init?.body ?? "{}"));
        if (body.kind === "external" && opts.externalStatus) {
          return Promise.resolve(jsonResponse(opts.externalStatus, { message: "Blocked target" }));
        }
        return Promise.resolve(
          jsonResponse(201, { slug: "abc123", kind: body.kind, projectId: 1, externalUrl: null }),
        );
      }
      if (url.endsWith("/token") && method === "POST") {
        return Promise.resolve(jsonResponse(200, { token: "tok" }));
      }
      // The proxy probe: a thrown fetch reads as "probably fine".
      return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  it("reports a project preview by what it shows, never by its iframe address", async () => {
    stubProxy({ token: true });
    useDashboardStore.setState({ projects: [PROJECT] });
    const onSourceChange = vi.fn();
    render(<BrowserPanel params={{ projectId: 1 }} onSourceChange={onSourceChange} />);
    const frame = await screen.findByTitle("Preview");
    expect(frame.getAttribute("src")).toContain("__mullion_preview=tok");
    expect(onSourceChange).toHaveBeenLastCalledWith({ kind: "project" });
    for (const [source] of onSourceChange.mock.calls) {
      expect(JSON.stringify(source)).not.toContain("__mullion_preview");
    }
  });

  it("reports a branch preview by its slug and an external preview by its address", async () => {
    stubProxy();
    useDashboardStore.setState({ projects: [PROJECT] });
    const onBranch = vi.fn();
    const { unmount } = render(
      <BrowserPanel params={{ projectId: 1, previewSlug: "br1" }} onSourceChange={onBranch} />,
    );
    await waitFor(() =>
      expect(onBranch).toHaveBeenLastCalledWith({ kind: "project", slug: "br1" }),
    );
    unmount();
    const onExternal = vi.fn();
    render(
      <BrowserPanel
        params={{ kind: "external", url: "https://example.com/a" }}
        onSourceChange={onExternal}
      />,
    );
    await waitFor(() =>
      expect(onExternal).toHaveBeenLastCalledWith({
        kind: "address",
        url: "https://example.com/a",
      }),
    );
  });

  it("reports a saved URL as its address", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/1/urls") {
        return Promise.resolve(
          jsonResponse(200, [
            {
              id: 9,
              projectId: 1,
              label: "Docs",
              url: "https://docs.example.com",
              favorite: false,
            },
          ]),
        );
      }
      if (url === "/api/server-info") {
        return Promise.resolve(
          jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT] });
    const onSourceChange = vi.fn();
    render(
      <BrowserPanel
        params={{ projectId: 1, activeSavedUrlId: 9, activeSavedUrlLabel: "Docs" }}
        onSourceChange={onSourceChange}
      />,
    );
    await waitFor(() =>
      expect(onSourceChange).toHaveBeenLastCalledWith({
        kind: "address",
        url: "https://docs.example.com",
      }),
    );
  });

  it("opens a page below the project preview's root, keeping the token and the preview host", async () => {
    stubProxy({ token: true });
    useDashboardStore.setState({ projects: [PROJECT] });
    render(<BrowserPanel params={{ projectId: 1, previewPath: "/a/b?x=1#h" }} />);
    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute(
      "src",
      `${window.location.protocol}//preview-abc123.preview.example.com/a/b?x=1&__mullion_preview=tok#h`,
    );
  });

  it("never lets a page path change the preview's host", async () => {
    stubProxy();
    useDashboardStore.setState({ projects: [PROJECT] });
    render(<BrowserPanel params={{ projectId: 1, previewPath: "//evil.example/x" }} />);
    const frame = await screen.findByTitle("Preview");
    expect(new URL(frame.getAttribute("src") ?? "").host).toBe(
      "preview-abc123.preview.example.com",
    );
  });

  it("drops the page path when the user picks the dev server again", async () => {
    stubProxy();
    useDashboardStore.setState({ projects: [PROJECT] });
    render(<BrowserPanel params={{ projectId: 1, previewPath: "/deep" }} />);
    const frame = await screen.findByTitle("Preview");
    expect(frame.getAttribute("src")).toMatch(/\/deep$/);
    await userEvent.click(screen.getByRole("button", { name: /Dev server/ }));
    const items = screen.getAllByRole("button", { name: "Dev server" });
    await userEvent.click(items[items.length - 1]);
    await waitFor(() =>
      expect(screen.getByTitle("Preview")).toHaveAttribute(
        "src",
        `${window.location.protocol}//preview-abc123.preview.example.com/`,
      ),
    );
  });

  it("offers the agent's browser when an external page cannot be shown", async () => {
    stubProxy({ externalStatus: 400 });
    const onShow = vi.fn();
    render(
      <BrowserPanel
        params={{ kind: "external", url: "https://example.com/" }}
        onShowInAgentBrowser={onShow}
      />,
    );
    expect(
      await screen.findByText(
        "This site cannot be shown as a preview. The agent's browser can show it.",
      ),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open in the agent's browser" }));
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("says nothing about the agent's browser without a way there, or for a non-http address", async () => {
    stubProxy({ externalStatus: 400 });
    const { unmount } = render(
      <BrowserPanel params={{ kind: "external", url: "https://example.com/" }} />,
    );
    expect(await screen.findByText("Blocked target")).toBeInTheDocument();
    expect(screen.queryByText(/The agent's browser can show it/)).toBeNull();
    unmount();
    render(
      <BrowserPanel
        params={{ kind: "external", url: "ftp://example.com/" }}
        onShowInAgentBrowser={vi.fn()}
      />,
    );
    expect(await screen.findByText(/scheme can't be previewed/)).toBeInTheDocument();
    expect(screen.queryByText(/The agent's browser can show it/)).toBeNull();
  });
});

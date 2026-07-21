// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserPanel } from "./BrowserPanel.js";
import { useDashboardStore } from "./store.js";
import type { Project, ServerInfo } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 1,
  name: "tessera",
  cwd: "/home/x/tessera",
  hostId: "local",
  devServerUrl: "5173",
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const SERVER_INFO_BASE = {
  version: "0.1.0",
  role: "primary" as const,
  nodeEnv: "test",
  port: 3000,
  encryptionEnabled: false,
  sessionsDir: "/tmp/sessions",
  dbPath: "/tmp/app.db",
  uptimeSeconds: 1,
  rateLimit: { max: 100, window: "1 minute" },
  projectsRoots: "",
  crsConfigDir: "~/.config/crs",
};

describe("BrowserPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ projects: [] });
  });

  it("shows a not-applicable message when the project has no devServerUrl, with only project-urls fetch", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [{ ...PROJECT, devServerUrl: null }] });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText(/no dev server URL configured/i)).toBeInTheDocument();
    // A single fetch for project URLs fires on mount (issue #109)
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/urls", expect.anything());
  });

  it("mentions a detected port in the not-applicable message when one was found (issue #28 phase 7)", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({
      projects: [{ ...PROJECT, devServerUrl: null, detectedDevServerPort: "5173" }],
    });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText(/detected one running on port 5173/i)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/projects/1/urls", expect.anything());
  });

  it("embeds the dev server URL directly (no POST) when previews aren't enabled server-wide", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT] });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute("src", PROJECT.devServerUrl);
    // Two calls: project-urls fetch + server-info fetch — no POST /api/previews
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("also embeds directly if previewsEnabled is true but previewBaseHost is somehow empty", async () => {
    // Defensive-only case (Hermes review, PR #46): server-info's two fields
    // should never actually disagree (previewsEnabled is derived from
    // PREVIEW_BASE_HOST being non-empty), but this guards against silently
    // building an invalid host like "preview-<slug>./" if they ever do —
    // falls back to the same direct-embed path as previewsEnabled: false.
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: true, previewBaseHost: "" }),
        ),
      ),
    );
    useDashboardStore.setState({ projects: [PROJECT] });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute("src", PROJECT.devServerUrl);
  });

  it("renders an iframe pointed at the resolved preview subdomain once everything is available", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/1/urls" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/server-info" && method === "GET") {
        const info: ServerInfo = {
          ...SERVER_INFO_BASE,
          previewsEnabled: true,
          previewBaseHost: "preview.example.com",
        };
        return Promise.resolve(jsonResponse(200, info));
      }
      if (url === "/api/previews" && method === "POST") {
        return Promise.resolve(
          jsonResponse(201, {
            slug: "abc123",
            kind: "project",
            projectId: 1,
            externalUrl: null,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projects: [PROJECT] });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute(
      "src",
      `${window.location.protocol}//preview-abc123.preview.example.com/`,
    );
  });

  it("degrades to an error message when creating the preview fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/projects/1/urls" && method === "GET") {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url === "/api/server-info" && method === "GET") {
          return Promise.resolve(
            jsonResponse(200, {
              ...SERVER_INFO_BASE,
              previewsEnabled: true,
              previewBaseHost: "preview.example.com",
            }),
          );
        }
        if (url === "/api/previews" && method === "POST") {
          return Promise.resolve(jsonResponse(404, { message: "Unknown project 1" }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      }),
    );
    useDashboardStore.setState({ projects: [PROJECT] });

    render(<BrowserPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("Unknown project 1")).toBeInTheDocument();
  });

  it("re-requests a preview when Reload is clicked", async () => {
    let previewCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/projects/1/urls" && method === "GET") {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url === "/api/server-info" && method === "GET") {
          return Promise.resolve(
            jsonResponse(200, {
              ...SERVER_INFO_BASE,
              previewsEnabled: true,
              previewBaseHost: "preview.example.com",
            }),
          );
        }
        if (url === "/api/previews" && method === "POST") {
          previewCalls += 1;
          return Promise.resolve(
            jsonResponse(201, {
              slug: "abc123",
              kind: "project",
              projectId: 1,
              externalUrl: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      }),
    );
    useDashboardStore.setState({ projects: [PROJECT] });

    const user = userEvent.setup();
    render(<BrowserPanel params={{ projectId: 1 }} />);
    await screen.findByTitle("Preview");
    expect(previewCalls).toBe(1);

    await user.click(screen.getByTitle("Reload"));
    await vi.waitFor(() => expect(previewCalls).toBe(2));
  });

  describe("kind: external (issue #28 phase 5)", () => {
    it("shows an empty-address-bar prompt when opened with no url and no fetch happens", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      render(<BrowserPanel params={{ kind: "external" }} />);

      expect(await screen.findByText(/Type a URL above/)).toBeInTheDocument();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("embeds a typed URL directly (no POST) when previews aren't enabled server-wide", async () => {
      const fetchMock = vi.fn(() =>
        Promise.resolve(
          jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
        ),
      );
      vi.stubGlobal("fetch", fetchMock);

      render(<BrowserPanel params={{ kind: "external", url: "https://example.com" }} />);

      const frame = await screen.findByTitle("Preview");
      expect(frame).toHaveAttribute("src", "https://example.com");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("refuses to embed a javascript: URL, even from a restored workspace layout's params.url (CodeQL: js/xss-through-dom)", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
          ),
        ),
      );

      render(
        <BrowserPanel params={{ kind: "external", url: "javascript:alert(document.domain)" }} />,
      );

      expect(await screen.findByText(/scheme can't be previewed/i)).toBeInTheDocument();
      expect(screen.queryByTitle("Preview")).not.toBeInTheDocument();
    });

    it("refuses to embed a data: URL the same way", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(() =>
          Promise.resolve(
            jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
          ),
        ),
      );

      render(
        <BrowserPanel params={{ kind: "external", url: "data:text/html,<script>1</script>" }} />,
      );

      expect(await screen.findByText(/scheme can't be previewed/i)).toBeInTheDocument();
    });

    it("reuses the pre-created slug from params instead of creating a second preview", async () => {
      let previewCalls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/server-info" && method === "GET") {
            return Promise.resolve(
              jsonResponse(200, {
                ...SERVER_INFO_BASE,
                previewsEnabled: true,
                previewBaseHost: "preview.example.com",
              }),
            );
          }
          if (url === "/api/previews" && method === "POST") {
            previewCalls += 1;
            return Promise.reject(new Error("should not create a preview — slug was pre-supplied"));
          }
          return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
        }),
      );

      render(
        <BrowserPanel
          params={{ kind: "external", url: "https://example.com", slug: "preseeded" }}
        />,
      );

      const frame = await screen.findByTitle("Preview");
      expect(frame).toHaveAttribute(
        "src",
        `${window.location.protocol}//preview-preseeded.preview.example.com/`,
      );
      expect(previewCalls).toBe(0);
    });

    it("navigating the address bar to a new URL creates a fresh preview and repoints the iframe", async () => {
      const createdUrls: string[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? "GET";
          if (url === "/api/server-info" && method === "GET") {
            return Promise.resolve(
              jsonResponse(200, {
                ...SERVER_INFO_BASE,
                previewsEnabled: true,
                previewBaseHost: "preview.example.com",
              }),
            );
          }
          if (url === "/api/previews" && method === "POST") {
            const body = JSON.parse(String(init?.body)) as { url: string };
            createdUrls.push(body.url);
            return Promise.resolve(
              jsonResponse(201, {
                slug: `slug-${createdUrls.length}`,
                kind: "external",
                projectId: null,
                externalUrl: body.url,
                createdAt: "2026-01-01T00:00:00.000Z",
              }),
            );
          }
          return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
        }),
      );

      const user = userEvent.setup();
      render(
        <BrowserPanel
          params={{ kind: "external", url: "https://example.com", slug: "preseeded" }}
        />,
      );
      await screen.findByTitle("Preview");

      const addressBar = screen.getByPlaceholderText("https://example.com");
      await user.clear(addressBar);
      await user.type(addressBar, "https://other.example{Enter}");

      await vi.waitFor(() => expect(createdUrls).toEqual(["https://other.example"]));
      const frame = await screen.findByTitle("Preview");
      expect(frame).toHaveAttribute(
        "src",
        `${window.location.protocol}//preview-slug-1.preview.example.com/`,
      );
    });
  });
});

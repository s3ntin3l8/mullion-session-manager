// @vitest-environment jsdom
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DockviewPanelApi } from "dockview-react";
import { BrowserPanel } from "./BrowserPanel.js";
import { useDashboardStore } from "./store.js";
import { api } from "./api.js";
import type { Project, ServerInfo } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const PROJECT: Project = {
  id: 1,
  name: "mullion",
  cwd: "/home/x/mullion",
  hostId: "local",
  devServerUrl: "5173",
  detectedDevServerPort: null,
  currentBranch: null,
  autoFetch: null,
  ruleFiles: [],
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
  taskMasterEnabled: false,
  previewAuthRequired: false,
};

describe("BrowserPanel", () => {
  beforeEach(() => {
    vi.spyOn(api, "getDevServerStatus").mockResolvedValue({ online: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    useDashboardStore.setState({ projects: [], sessions: [] });
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
    // Three calls: project-urls fetch + server-info fetch (fires once on
    // mount, then again when savedUrls is populated by the first fetch)
    expect(fetchMock).toHaveBeenCalledTimes(3);
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
    // Two preview calls: one from the initial effect, one from the effect
    // re-firing when savedUrls is populated by the project-urls fetch
    expect(previewCalls).toBe(2);

    await user.click(screen.getByTitle("Reload"));
    await vi.waitFor(() => expect(previewCalls).toBe(3));
  });

  describe("kind: external (issue #28 phase 5)", () => {
    it("shows an empty-address-bar prompt when opened with no url and fetches favorite URLs", async () => {
      const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, [])));
      vi.stubGlobal("fetch", fetchMock);

      render(<BrowserPanel params={{ kind: "external" }} />);

      expect(await screen.findByText(/Type a URL above/)).toBeInTheDocument();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock).toHaveBeenCalledWith("/api/browser-urls/favorites", expect.anything());
    });

    it("embeds a typed URL directly (no POST) when previews aren't enabled server-wide", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/server-info") {
          return Promise.resolve(
            jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
          );
        }
        if (url === "/api/browser-urls/favorites") {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.reject(new Error(`unhandled fetch: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      render(<BrowserPanel params={{ kind: "external", url: "https://example.com" }} />);

      const frame = await screen.findByTitle("Preview");
      expect(frame).toHaveAttribute("src", "https://example.com");
      expect(fetchMock).toHaveBeenCalledTimes(2);
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

  describe("saved URLs (issue #109)", () => {
    const SAVED_URLS = [
      {
        id: 10,
        projectId: 1,
        label: "Staging",
        url: "https://staging.example.com",
        favorite: true,
        order: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 11,
        projectId: 1,
        label: "CI",
        url: "https://ci.example.com",
        favorite: false,
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];

    function stubFetch(
      handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
    ) {
      vi.stubGlobal("fetch", vi.fn(handler));
    }

    const noPreviewInfo = { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" };
    const previewInfo = {
      ...SERVER_INFO_BASE,
      previewsEnabled: true,
      previewBaseHost: "preview.example.com",
    };

    it("shows a URL selector dropdown with saved URLs and Dev server option", async () => {
      useDashboardStore.setState({ projects: [PROJECT], projectUrls: { 1: SAVED_URLS } });
      stubFetch((url) => {
        const s = String(url);
        if (s === "/api/projects/1/urls") return Promise.resolve(jsonResponse(200, SAVED_URLS));
        if (s === "/api/server-info") return Promise.resolve(jsonResponse(200, noPreviewInfo));
        return Promise.reject(new Error(`unhandled: ${s}`));
      });

      render(<BrowserPanel params={{ projectId: 1 }} />);
      await screen.findByTitle("Preview");
      await userEvent.setup().click(screen.getByText("Dev server"));

      expect(await screen.findByText("Staging")).toBeInTheDocument();
      expect(await screen.findByText("CI")).toBeInTheDocument();
      expect(await screen.findByText("Manage URLs…")).toBeInTheDocument();
    });

    it("shows a favorited star indicator on saved URLs that are favorited", async () => {
      useDashboardStore.setState({ projects: [PROJECT], projectUrls: { 1: SAVED_URLS } });
      stubFetch((url) => {
        const s = String(url);
        if (s === "/api/projects/1/urls") return Promise.resolve(jsonResponse(200, SAVED_URLS));
        if (s === "/api/server-info") return Promise.resolve(jsonResponse(200, noPreviewInfo));
        return Promise.reject(new Error(`unhandled: ${s}`));
      });

      render(<BrowserPanel params={{ projectId: 1 }} />);
      await screen.findByTitle("Preview");
      await userEvent.setup().click(screen.getByText("Dev server"));

      await screen.findByText("Staging");
      // Only Staging (favorite: true) has a star
      const stars = document.querySelectorAll(".browser-panel-dropdown-star");
      expect(stars.length).toBe(1);
    });

    it("clicking a saved URL creates an external preview and navigates the iframe", async () => {
      const savedUrls = SAVED_URLS.slice(0, 1);
      useDashboardStore.setState({ projects: [PROJECT], projectUrls: { 1: savedUrls } });
      let externalCallCount = 0;
      stubFetch((input, init) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/projects/1/urls") return Promise.resolve(jsonResponse(200, savedUrls));
        if (url === "/api/server-info" && method === "GET") {
          return Promise.resolve(jsonResponse(200, previewInfo));
        }
        if (url === "/api/previews" && method === "POST") {
          const body = JSON.parse(String(init?.body)) as { kind?: string; url?: string };
          if (body.kind === "external") {
            externalCallCount += 1;
            const slug = `slug-ext-${externalCallCount}`;
            return Promise.resolve(
              jsonResponse(201, {
                slug,
                kind: "external",
                projectId: null,
                externalUrl: body.url,
                createdAt: "2026-01-01T00:00:00.000Z",
              }),
            );
          }
          return Promise.resolve(
            jsonResponse(201, {
              slug: "slug-proj",
              kind: "project",
              projectId: 1,
              externalUrl: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled: ${method} ${url}`));
      });

      const user = userEvent.setup();
      render(<BrowserPanel params={{ projectId: 1 }} />);
      await screen.findByTitle("Preview");

      await user.click(screen.getByText("Dev server"));
      await screen.findByText("Staging");
      await user.click(screen.getByText("Staging"));

      await vi.waitFor(() => expect(externalCallCount).toBe(1));
      const frame = screen.getByTitle("Preview");
      expect(frame).toHaveAttribute(
        "src",
        `${window.location.protocol}//preview-slug-ext-1.preview.example.com/`,
      );
    });
  });

  it("auto-prepends protocol+scheme when the user types a bare domain and presses Enter", async () => {
    const createdUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/browser-urls/favorites") {
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
          const body = JSON.parse(String(init?.body)) as { url: string };
          createdUrls.push(body.url);
          return Promise.resolve(
            jsonResponse(201, {
              slug: "bare-domain-slug",
              kind: "external",
              projectId: null,
              externalUrl: body.url,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
      }),
    );

    const user = userEvent.setup();
    render(<BrowserPanel params={{ kind: "external" }} />);
    const addressBar = screen.getByPlaceholderText("https://example.com");
    await user.type(addressBar, "example.com");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(createdUrls.length).toBe(1));
    expect(createdUrls[0]).toBe(`${window.location.protocol}//example.com`);
    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute(
      "src",
      `${window.location.protocol}//preview-bare-domain-slug.preview.example.com/`,
    );
  });

  it("leaves an explicit http:// scheme alone — no double-prepend", async () => {
    const createdUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url === "/api/browser-urls/favorites") {
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
          const body = JSON.parse(String(init?.body)) as { url: string };
          createdUrls.push(body.url);
          return Promise.resolve(
            jsonResponse(201, {
              slug: "explicit-slug",
              kind: "external",
              projectId: null,
              externalUrl: body.url,
              createdAt: "2026-01-01T00:00:00.000Z",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
      }),
    );

    const user = userEvent.setup();
    render(<BrowserPanel params={{ kind: "external" }} />);
    const addressBar = screen.getByPlaceholderText("https://example.com");
    await user.clear(addressBar);
    await user.type(addressBar, "http://example.com");
    await user.keyboard("{Enter}");

    await vi.waitFor(() => expect(createdUrls.length).toBe(1));
    expect(createdUrls[0]).toBe("http://example.com");
  });

  it("normalizes params.url without a scheme on init", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/browser-urls/favorites") {
          return Promise.resolve(jsonResponse(200, []));
        }
        if (url === "/api/server-info") {
          return Promise.resolve(
            jsonResponse(200, {
              ...SERVER_INFO_BASE,
              previewsEnabled: false,
              previewBaseHost: "",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled fetch: ${url}`));
      }),
    );

    render(<BrowserPanel params={{ kind: "external", url: "example.com" }} />);

    const frame = await screen.findByTitle("Preview");
    expect(frame).toHaveAttribute("src", `${window.location.protocol}//example.com`);
  });

  it("shows the refresh button in unavailable state so the user can retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/browser-urls/favorites") {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.resolve(jsonResponse(500, { message: "Server error" }));
      }),
    );

    render(<BrowserPanel params={{ kind: "external", url: "https://broken.example.com" }} />);

    await screen.findByText("Server error");
    expect(screen.getByTitle("Reload")).toBeInTheDocument();
  });

  it("shows the back and forward buttons disabled when there is no history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/browser-urls/favorites") {
          return Promise.resolve(jsonResponse(200, []));
        }
        return Promise.resolve(
          jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false, previewBaseHost: "" }),
        );
      }),
    );

    render(<BrowserPanel params={{ kind: "external" }} />);

    const backBtn = screen.getByTitle("Back");
    const forwardBtn = screen.getByTitle("Forward");
    expect(backBtn).toBeDisabled();
    expect(forwardBtn).toBeDisabled();
  });

  it("shows favorited URLs across all projects in a dropdown in external mode", async () => {
    const FAV_URLS = [
      {
        id: 20,
        projectId: 1,
        label: "Staging",
        url: "https://staging.example.com",
        favorite: true,
        order: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: 21,
        projectId: 2,
        label: "CI",
        url: "https://ci.example.com",
        favorite: true,
        order: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/browser-urls/favorites") {
          return Promise.resolve(jsonResponse(200, FAV_URLS));
        }
        if (url === "/api/server-info") {
          return Promise.resolve(
            jsonResponse(200, {
              ...SERVER_INFO_BASE,
              previewsEnabled: false,
              previewBaseHost: "",
            }),
          );
        }
        return Promise.reject(new Error(`unhandled fetch: ${url}`));
      }),
    );
    useDashboardStore.setState({
      projects: [
        { ...PROJECT, id: 1, name: "mullion" },
        { ...PROJECT, id: 2, name: "other-project" },
      ],
    });

    const user = userEvent.setup();
    render(<BrowserPanel params={{ kind: "external", url: "https://example.com" }} />);
    await screen.findByTitle("Preview");

    const favBtn = screen.getByTitle("Favorites");
    await user.click(favBtn);

    expect(await screen.findByText("Staging")).toBeInTheDocument();
    expect(await screen.findByText("CI")).toBeInTheDocument();
    expect(screen.getByText(/mullion/)).toBeInTheDocument();
    expect(screen.getByText(/other-project/)).toBeInTheDocument();
  });

  describe("preview-host auth token (issue #383)", () => {
    it("appends the bootstrap token query param to the iframe src when previewAuthRequired is true", async () => {
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
            previewAuthRequired: true,
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
        if (url === "/api/previews/abc123/token" && method === "POST") {
          return Promise.resolve(jsonResponse(200, { token: "bootstrap-token-value" }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      useDashboardStore.setState({ projects: [PROJECT] });

      render(<BrowserPanel params={{ projectId: 1 }} />);

      const frame = await screen.findByTitle("Preview");
      expect(frame).toHaveAttribute(
        "src",
        `${window.location.protocol}//preview-abc123.preview.example.com/?__mullion_preview=bootstrap-token-value`,
      );
    });

    it("does not mint a bootstrap token when previewAuthRequired is false", async () => {
      // The existing "renders an iframe pointed at the resolved preview
      // subdomain" test above already proves this implicitly (its fetch
      // stub has no handler for POST /api/previews/:slug/token, so an
      // unwanted call there would reject and fail the test) — this test
      // makes the assertion explicit and asserts the exact plain src too.
      const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
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
              previewAuthRequired: false,
            }),
          );
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
      expect(fetchMock).not.toHaveBeenCalledWith(
        expect.stringContaining("/token"),
        expect.anything(),
      );
    });

    it("still recovers the plain slug via the dockview panel params once a token query param is appended", async () => {
      const updateParameters = vi.fn();
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
            previewAuthRequired: true,
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
        if (url === "/api/previews/abc123/token" && method === "POST") {
          return Promise.resolve(jsonResponse(200, { token: "bootstrap-token-value" }));
        }
        return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);
      useDashboardStore.setState({ projects: [PROJECT] });

      render(
        <BrowserPanel
          params={{ projectId: 1 }}
          api={{ updateParameters } as unknown as DockviewPanelApi}
        />,
      );

      await screen.findByTitle("Preview");
      await vi.waitFor(() => {
        const lastCall = updateParameters.mock.calls.at(-1)?.[0] as { slug?: string } | undefined;
        expect(lastCall?.slug).toBe("abc123");
      });
    });
  });

  describe("Remediation Plan Additions", () => {
    it("renders the dev server status dot (online/offline) based on endpoint status", async () => {
      vi.spyOn(api, "getDevServerStatus").mockResolvedValue({ online: false });
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/urls")) return Promise.resolve(jsonResponse(200, []));
        if (url.endsWith("/server-info")) {
          return Promise.resolve(
            jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false }),
          );
        }
        return Promise.reject(new Error(`unhandled: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      useDashboardStore.setState({ projects: [PROJECT] });
      render(<BrowserPanel params={{ projectId: 1 }} />);

      expect(await screen.findByTitle("Dev server offline")).toBeInTheDocument();
    });

    it("toggles Follow Agent state when follow button is clicked", async () => {
      const fetchMock = vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/urls")) return Promise.resolve(jsonResponse(200, []));
        if (url.endsWith("/server-info")) {
          return Promise.resolve(
            jsonResponse(200, { ...SERVER_INFO_BASE, previewsEnabled: false }),
          );
        }
        return Promise.reject(new Error(`unhandled: ${url}`));
      });
      vi.stubGlobal("fetch", fetchMock);

      useDashboardStore.setState({
        projects: [PROJECT],
        activePanelId: "session-10",
        sessions: [
          {
            id: 10,
            projectId: 1,
            kind: "dock",
            status: "active",
            command: "npm run dev",
            browserUrl: "https://agent-navigated.com",
            createdAt: "2026-01-01T00:00:00.000Z",
          } as any,
        ],
      });

      const user = userEvent.setup();
      render(<BrowserPanel params={{ projectId: 1 }} />);

      const followBtn = await screen.findByTitle("Follow Agent URL Sync");
      expect(followBtn).not.toHaveClass("active");

      await user.click(followBtn);
      expect(followBtn).toHaveClass("active");

      await user.click(followBtn);
      expect(followBtn).not.toHaveClass("active");
    });
  });
});

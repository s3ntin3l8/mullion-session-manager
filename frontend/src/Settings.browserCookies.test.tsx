// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "./Settings.js";
import { useDashboardStore } from "./store.js";
import type { BrowserCookieProfile, GitHubIntegration, Project } from "./api.js";

// Mirrors Settings.integrations.test.tsx / Settings.hosts.test.tsx's
// fake-in-memory-backend pattern (issue #184) — a fake server over global
// fetch, not a mocked store, so the real request()/store wiring is what's
// under test.

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const DISCONNECTED_GITHUB: GitHubIntegration = {
  connected: false,
  tokenType: null,
  login: null,
  scopes: null,
  connectedAt: null,
  deviceFlowAvailable: false,
};

const PROJECT_A: Project = {
  id: 1,
  name: "project-a",
  cwd: "/home/user/project-a",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const PROJECT_B: Project = {
  id: 2,
  name: "project-b",
  cwd: "/home/user/project-b",
  hostId: "local",
  devServerUrl: null,
  detectedDevServerPort: null,
  currentBranch: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("Settings -> Integrations -> Import Browser Cookies", () => {
  let profilesByProject: Map<number, BrowserCookieProfile[]>;
  let nextId: number;
  let fetchMock: ReturnType<typeof vi.fn>;
  let unexpectedCalls: string[];

  beforeEach(() => {
    profilesByProject = new Map([[PROJECT_A.id, []]]);
    nextId = 1;
    unexpectedCalls = [];

    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "/api/integrations/github" && method === "GET") {
        return Promise.resolve(jsonResponse(200, DISCONNECTED_GITHUB));
      }

      const listMatch = url.match(/^\/api\/projects\/(\d+)\/browser-cookies$/);
      if (listMatch && method === "GET") {
        const projectId = Number(listMatch[1]);
        return Promise.resolve(jsonResponse(200, profilesByProject.get(projectId) ?? []));
      }

      const importMatch = url.match(/^\/api\/projects\/(\d+)\/browser-cookies\/import$/);
      if (importMatch && method === "POST") {
        const projectId = Number(importMatch[1]);
        const body = JSON.parse(String(init?.body)) as {
          browser: "chrome" | "firefox";
          profilePath: string;
          label: string;
        };
        if (body.profilePath === "/does/not/exist") {
          return Promise.resolve(
            jsonResponse(400, { message: "Cookie database not found: /does/not/exist" }),
          );
        }
        const profile: BrowserCookieProfile = {
          id: nextId++,
          projectId,
          label: body.label,
          browser: body.browser,
          cookieCount: 3,
          importedAt: "2026-01-01T00:00:00.000Z",
        };
        const existing = profilesByProject.get(projectId) ?? [];
        profilesByProject.set(projectId, [
          ...existing.filter((p) => p.label !== body.label),
          profile,
        ]);
        return Promise.resolve(jsonResponse(201, profile));
      }

      const deleteMatch = url.match(/^\/api\/projects\/(\d+)\/browser-cookies\/(\d+)$/);
      if (deleteMatch && method === "DELETE") {
        const projectId = Number(deleteMatch[1]);
        const id = Number(deleteMatch[2]);
        const existing = profilesByProject.get(projectId) ?? [];
        profilesByProject.set(
          projectId,
          existing.filter((p) => p.id !== id),
        );
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      unexpectedCalls.push(`${method} ${url}`);
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    // The store is a module-level singleton — seed the slice this test
    // touches so a previous test's state doesn't leak into this one.
    useDashboardStore.setState({ projects: [PROJECT_A, PROJECT_B] });
  });

  afterEach(() => {
    expect(unexpectedCalls).toEqual([]);
    vi.unstubAllGlobals();
  });

  it("shows an empty state when nothing has been imported for the selected project", async () => {
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    expect(await screen.findByText("No cookie profiles imported yet")).toBeInTheDocument();
  });

  it("imports a profile and lists it", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    await screen.findByText("No cookie profiles imported yet");

    await user.type(
      screen.getByPlaceholderText("~/.config/google-chrome/Default/Cookies"),
      "/home/user/.config/google-chrome/Default/Cookies",
    );
    await user.type(screen.getByPlaceholderText("work"), "work");
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText("work")).toBeInTheDocument();
    expect(screen.getByText("chrome · 3 cookies")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/1/browser-cookies/import",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("shows an inline error when the import fails, without adding a row", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    await screen.findByText("No cookie profiles imported yet");

    await user.type(
      screen.getByPlaceholderText("~/.config/google-chrome/Default/Cookies"),
      "/does/not/exist",
    );
    await user.type(screen.getByPlaceholderText("work"), "work");
    await user.click(screen.getByRole("button", { name: "Import" }));

    expect(await screen.findByText(/Cookie database not found/)).toBeInTheDocument();
    expect(screen.getByText("No cookie profiles imported yet")).toBeInTheDocument();
  });

  it("deletes an imported profile", async () => {
    profilesByProject.set(PROJECT_A.id, [
      {
        id: 5,
        projectId: PROJECT_A.id,
        label: "personal",
        browser: "firefox",
        cookieCount: 7,
        importedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);

    expect(await screen.findByText("personal")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() =>
      expect(screen.getByText("No cookie profiles imported yet")).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/projects/1/browser-cookies/5",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("switches the profile list when a different project is selected", async () => {
    profilesByProject.set(PROJECT_B.id, [
      {
        id: 9,
        projectId: PROJECT_B.id,
        label: "b-label",
        browser: "chrome",
        cookieCount: 2,
        importedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="integrations" />);
    await screen.findByText("No cookie profiles imported yet");

    await user.selectOptions(screen.getByDisplayValue("project-a"), "project-b");

    expect(await screen.findByText("b-label")).toBeInTheDocument();
  });
});

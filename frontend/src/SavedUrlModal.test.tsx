// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SavedUrlModal } from "./SavedUrlModal.js";
import { useDashboardStore } from "./store.js";
import type { ProjectUrl } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const URLS: ProjectUrl[] = [
  {
    id: 1,
    projectId: 5,
    label: "Production",
    url: "https://prod.example.com",
    favorite: true,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    id: 2,
    projectId: 5,
    label: "Staging",
    url: "https://staging.example.com",
    favorite: false,
    order: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("SavedUrlModal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    useDashboardStore.setState({ projectUrls: {} });
  });

  function commonFetchMock() {
    return vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/5/urls") {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.reject(new Error(`unhandled fetch: ${url}`));
    });
  }

  it("renders existing saved URLs with labels and URLs", () => {
    vi.stubGlobal("fetch", commonFetchMock());
    useDashboardStore.setState({ projectUrls: { 5: URLS } });
    const onClose = vi.fn();

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Staging")).toBeInTheDocument();
    expect(screen.getByText("https://prod.example.com")).toBeInTheDocument();
    expect(screen.getByText("https://staging.example.com")).toBeInTheDocument();
  });

  it("shows an empty state when no URLs exist", () => {
    vi.stubGlobal("fetch", commonFetchMock());
    useDashboardStore.setState({ projectUrls: { 5: [] } });
    const onClose = vi.fn();

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    expect(screen.getByText(/No saved URLs yet/)).toBeInTheDocument();
  });

  it("closes when the backdrop is clicked", async () => {
    vi.stubGlobal("fetch", commonFetchMock());
    useDashboardStore.setState({ projectUrls: { 5: [] } });
    const onClose = vi.fn();

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    const backdrop = screen.getByRole("heading").closest(".overlay-backdrop")!;
    await userEvent.setup().click(backdrop);
    expect(onClose).toHaveBeenCalled();
  });

  it("creates a new URL via the API and clears the form on success", async () => {
    useDashboardStore.setState({ projectUrls: { 5: [] } });
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/5/urls" && method === "GET") {
        return Promise.resolve(jsonResponse(200, []));
      }
      if (url === "/api/projects/5/urls" && method === "POST") {
        return Promise.resolve(
          jsonResponse(201, {
            id: 3,
            projectId: 5,
            label: "CI",
            url: "https://ci.example.com",
            favorite: false,
            order: 2,
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    const labelInput = screen.getByPlaceholderText("Label (e.g. Production)");
    const urlInput = screen.getByPlaceholderText("https://example.com");
    await userEvent.setup().type(labelInput, "CI");
    await userEvent.setup().type(urlInput, "https://ci.example.com");
    await userEvent.setup().click(screen.getByText("Add"));

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/5/urls",
        expect.objectContaining({
          method: "POST",
          body: expect.stringContaining("https://ci.example.com"),
        }),
      );
    });
  });

  it("disables Add button when inputs are empty or URL is invalid", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/projects/5/urls") {
        return Promise.resolve(jsonResponse(200, []));
      }
      return Promise.reject(new Error(`unhandled fetch: ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
    useDashboardStore.setState({ projectUrls: { 5: [] } });
    const onClose = vi.fn();

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);
    await screen.findByPlaceholderText("Label (e.g. Production)");

    const addBtn = screen.getByText("Add");
    expect(addBtn).toBeDisabled();
  });

  it("toggles favorite via the star button", async () => {
    useDashboardStore.setState({ projectUrls: { 5: URLS } });
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/5/urls" && method === "GET") {
        return Promise.resolve(jsonResponse(200, URLS));
      }
      if (url.startsWith("/api/projects/5/urls/") && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, { ...URLS[0], favorite: false }));
      }
      return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    const starBtn = screen.getByTitle("Remove from favorites");
    await userEvent.setup().click(starBtn);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/5/urls/1",
        expect.objectContaining({
          method: "PATCH",
          body: expect.stringContaining('"favorite":false'),
        }),
      );
    });
  });

  it("deletes a URL via the delete button", async () => {
    useDashboardStore.setState({ projectUrls: { 5: URLS } });
    const onClose = vi.fn();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/projects/5/urls" && method === "GET") {
        return Promise.resolve(jsonResponse(200, URLS));
      }
      if (url.startsWith("/api/projects/5/urls/") && method === "DELETE") {
        return Promise.resolve(jsonResponse(204, undefined));
      }
      return Promise.reject(new Error(`unhandled fetch: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SavedUrlModal projectId={5} projectName="test-project" onClose={onClose} />);

    const deleteButtons = screen.getAllByTitle("Delete");
    await userEvent.setup().click(deleteButtons[0]);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/5/urls/1",
        expect.objectContaining({ method: "DELETE" }),
      );
    });
  });
});

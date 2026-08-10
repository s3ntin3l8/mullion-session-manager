// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DockConfigPanel } from "./DockConfigPanel.js";
import type { DockConfigResult, DockControlInput } from "./api.js";
import { useDashboardStore } from "./store.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeResult(
  controls: DockControlInput[] = [],
  overrides: Partial<DockConfigResult> = {},
): DockConfigResult {
  return { controls, invalid: false, reason: null, isSymlink: false, ...overrides };
}

// Same "route a mocked fetch by URL/method, unhandled requests reject
// loudly" convention as AgentRulesPanel.test.tsx's own mockFetch.
function mockFetch(opts: {
  get?: () => Response | Promise<Response>;
  put?: (body: unknown) => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/dock/config") && method === "GET") {
      return Promise.resolve(opts.get ? opts.get() : new Response(null, { status: 200 }));
    }
    if (url.includes("/dock/config") && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      return Promise.resolve(opts.put ? opts.put(body) : new Response(null, { status: 500 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("DockConfigPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the config resolves", () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => new Promise(() => {}) }));
    render(<DockConfigPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("offers a manual Retry button on initial load failure, which succeeds on click", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => {
          attempt++;
          if (attempt === 1) return Promise.reject(new Error("network error"));
          return jsonResponse(
            200,
            makeResult([{ id: "logs", title: "Logs", command: "tail -f log" }]),
          );
        },
      }),
    );
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    const retryButton = await screen.findByText("Retry");
    expect(screen.getByText("Couldn't load dock.json.")).toBeInTheDocument();

    await user.click(retryButton);

    expect(await screen.findByText("Logs")).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("renders existing monitors from the loaded config", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () =>
          jsonResponse(
            200,
            makeResult([
              { id: "dev-server", title: "Dev server", command: "make dev" },
              { id: "logs", title: "Logs", command: "tail -f log" },
            ]),
          ),
      }),
    );
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("Dev server")).toBeInTheDocument();
    expect(screen.getByText("Logs")).toBeInTheDocument();
  });

  it("selecting a monitor loads its fields into the form", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () =>
          jsonResponse(
            200,
            makeResult([
              {
                id: "dev-server",
                title: "Dev server",
                command: "make dev",
                cwd: "packages/frontend",
                height: 300,
              },
            ]),
          ),
      }),
    );
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("Dev server"));
    expect(screen.getByDisplayValue("dev-server")).toBeInTheDocument();
    expect(screen.getByDisplayValue("make dev")).toBeInTheDocument();
    expect(screen.getByDisplayValue("packages/frontend")).toBeInTheDocument();
    expect(screen.getByDisplayValue("300")).toBeInTheDocument();
  });

  it("adding a monitor and filling fields, then saving, PUTs the full controls array and refreshes the Dock", async () => {
    const fetchMock = mockFetch({
      get: () => jsonResponse(200, makeResult([])),
      put: (body) =>
        jsonResponse(200, makeResult((body as { controls: DockControlInput[] }).controls)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    await screen.findByText("No monitors configured yet.");
    const triggerBefore = useDashboardStore.getState().dockConfigRefreshTrigger;

    await user.click(screen.getByText("Add monitor"));
    await user.type(screen.getByPlaceholderText("dev-server"), "dev-server");
    await user.type(screen.getByPlaceholderText("Dev server"), "Dev server");
    await user.type(screen.getByPlaceholderText("npm run dev"), "make dev");

    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    expect(await screen.findByText("Save")).toBeDisabled();
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      controls: [{ id: "dev-server", title: "Dev server", command: "make dev" }],
    });
    expect(useDashboardStore.getState().dockConfigRefreshTrigger).toBe(triggerBefore + 1);
  });

  it("shows a server-side validation error inline, without losing the draft or bumping the refresh trigger", async () => {
    const fetchMock = mockFetch({
      get: () => jsonResponse(200, makeResult([{ id: "x", title: "X", command: "echo x" }])),
      put: () => jsonResponse(400, { message: "controls[0].title must be a non-empty string" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("X"));
    const triggerBefore = useDashboardStore.getState().dockConfigRefreshTrigger;
    const titleInput = screen.getByDisplayValue("X");
    await user.clear(titleInput);
    await user.click(screen.getByText("Save"));

    expect(await screen.findByText(/must be a non-empty string/)).toBeInTheDocument();
    // The draft (now-empty title) is preserved, not reverted.
    expect(screen.getByPlaceholderText("Dev server")).toHaveValue("");
    expect(useDashboardStore.getState().dockConfigRefreshTrigger).toBe(triggerBefore);
  });

  it("shows an inline notice, and still allows saving a fresh config, when the on-disk file is invalid", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, makeResult([], { invalid: true, reason: "Not valid JSON" })),
      }),
    );
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText(/invalid: Not valid JSON/)).toBeInTheDocument();
  });

  // Regression: an earlier version of this panel put Save inside the
  // per-monitor `selected` branch. Removing the only (or currently
  // selected) monitor unmounted that branch along with Save — the removal
  // could never be persisted. Save must stay reachable throughout.
  it("removing the only monitor takes it out of the list, keeps Save enabled and reachable, and PUTs an empty controls array", async () => {
    const fetchMock = mockFetch({
      get: () => jsonResponse(200, makeResult([{ id: "x", title: "X", command: "echo x" }])),
      put: (body) =>
        jsonResponse(200, makeResult((body as { controls: DockControlInput[] }).controls)),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("X"));
    const removeButton = screen.getByTitle(/Remove X\?/);
    await user.click(removeButton);
    await user.click(removeButton);

    expect(await screen.findByText("No monitors configured yet.")).toBeInTheDocument();
    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();

    await user.click(saveButton);
    expect(await screen.findByText("Save")).toBeDisabled();
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({ controls: [] });
  });

  it("adds and removes an environment variable row", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, makeResult([{ id: "x", title: "X", command: "echo x" }])),
      }),
    );
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("X"));
    await user.click(screen.getByText("Add variable"));
    await user.type(screen.getByPlaceholderText("KEY"), "NODE_ENV");
    await user.type(screen.getByPlaceholderText("value"), "development");
    expect(screen.getByDisplayValue("NODE_ENV")).toBeInTheDocument();

    await user.click(screen.getByTitle("Remove"));
    expect(screen.queryByPlaceholderText("KEY")).not.toBeInTheDocument();
  });

  // Hermes fresh-review nit on PR #586 — a symlinked dock.json used to load
  // as a normal, editable config; Save would only then hard-400 via
  // DockConfigSymlinkError. Mirrors AgentRulesPanel's own symlink-notice
  // test.
  it("shows a symlink notice and keeps Save disabled even once dirty, instead of a doomed round trip", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () =>
          jsonResponse(
            200,
            makeResult([{ id: "x", title: "X", command: "echo x" }], { isSymlink: true }),
          ),
      }),
    );
    const user = userEvent.setup();
    render(<DockConfigPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText(/is a symlink/)).toBeInTheDocument();
    // Dirty the form (add a monitor) — without the isSymlink check, Save
    // would now read as enabled, exactly the "loads as editable, Save
    // hard-400s" gap the review nit flagged.
    await user.click(screen.getByText("Add monitor"));
    expect(screen.getByText("Save")).toBeDisabled();
  });
});

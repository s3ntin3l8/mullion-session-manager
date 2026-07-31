// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentRulesPanel } from "./AgentRulesPanel.js";
import type { AgentRuleTarget } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeTarget(overrides: Partial<AgentRuleTarget> = {}): AgentRuleTarget {
  return {
    id: "claude-code:project",
    agent: "claude-code",
    agentLabel: "Claude Code",
    scope: "project",
    fileName: "CLAUDE.md",
    absolutePath: "/repo/CLAUDE.md",
    exists: false,
    size: null,
    mtimeMs: null,
    status: null,
    content: null,
    truncated: false,
    ...overrides,
  };
}

const CODEX_AGENTS = makeTarget({
  id: "codex:project",
  agent: "codex",
  agentLabel: "Codex",
  fileName: "AGENTS.md",
  absolutePath: "/repo/AGENTS.md",
  exists: true,
  size: 20,
  mtimeMs: 1,
  status: "shadowed",
  content: "base rules",
});

const CODEX_OVERRIDE = makeTarget({
  id: "codex:project:override",
  agent: "codex",
  agentLabel: "Codex",
  fileName: "AGENTS.override.md",
  absolutePath: "/repo/AGENTS.override.md",
  exists: true,
  size: 24,
  mtimeMs: 2,
  status: "active",
  content: "override rules",
});

// Routes a mocked fetch by URL/method — unhandled requests reject loudly,
// same "trap for unexpected requests" convention as GitPanel.test.tsx's own
// mockFetch.
function mockFetch(opts: {
  list?: () => Response | Promise<Response>;
  write?: (body: unknown) => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/agent-rules") && method === "GET") {
      return Promise.resolve(opts.list ? opts.list() : new Response(null, { status: 200 }));
    }
    if (url.includes("/agent-rules/") && method === "PUT") {
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      return Promise.resolve(opts.write ? opts.write(body) : new Response(null, { status: 500 }));
    }
    if (url.includes("/agent-rules/") && method === "DELETE") {
      return Promise.resolve(opts.del ? opts.del() : new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("AgentRulesPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the list resolves", () => {
    vi.stubGlobal("fetch", mockFetch({ list: () => new Promise(() => {}) }));
    render(<AgentRulesPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  // Issue #431, Hermes review on PR #458 — the initial "retrying…" copy
  // implied an automatic retry that never happened. A manual Retry button
  // both fixes the honesty gap and genuinely re-fetches.
  it("offers a manual Retry button on initial load failure, which succeeds on click", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        list: () => {
          attempt++;
          if (attempt === 1) return Promise.reject(new Error("network error"));
          return jsonResponse(200, [CODEX_OVERRIDE]);
        },
      }),
    );
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    const retryButton = await screen.findByText("Retry");
    expect(screen.getByText("Couldn't load agent rules.")).toBeInTheDocument();

    await user.click(retryButton);

    expect(await screen.findByText("AGENTS.override.md")).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("groups targets by agent and marks a shadowed file distinctly from an active one", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ list: () => jsonResponse(200, [CODEX_AGENTS, CODEX_OVERRIDE]) }),
    );
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("Codex")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.md")).toBeInTheDocument();
    expect(screen.getByText("AGENTS.override.md")).toBeInTheDocument();
    // Both rows carry their own meta text distinguishing shadowed vs active.
    expect(screen.getByText(/Shadowed/)).toBeInTheDocument();
    expect(screen.getByText(/Active/)).toBeInTheDocument();
  });

  it("selecting a row loads its content into the editor and shows a shadowed notice", async () => {
    vi.stubGlobal("fetch", mockFetch({ list: () => jsonResponse(200, [CODEX_AGENTS]) }));
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("AGENTS.md"));
    expect(screen.getByDisplayValue("base rules")).toBeInTheDocument();
    expect(screen.getByText(/already wins/)).toBeInTheDocument();
  });

  it("saves edited content via PUT and reflects the updated target", async () => {
    const fetchMock = mockFetch({
      list: () => jsonResponse(200, [CODEX_OVERRIDE]),
      write: (body) =>
        jsonResponse(200, { ...CODEX_OVERRIDE, content: (body as { content: string }).content }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("AGENTS.override.md"));
    const textarea = screen.getByDisplayValue("override rules");
    await user.clear(textarea);
    await user.type(textarea, "new content");

    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    expect(await screen.findByText("Save")).toBeDisabled();
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      content: "new content",
    });
  });

  it("deletes an existing file via DELETE, then refetches so the editor (and any sibling's shadow status) reflects the real post-delete state", async () => {
    // Issue #431, Hermes review on PR #458 — a client-side-only patch of
    // the deleted target used to leave a sibling's shadow status stale
    // (e.g. deleting AGENTS.override.md should flip the sibling AGENTS.md
    // row from "shadowed" back to "active", which only a real refetch can
    // reflect). Stateful list mock: the first GET (mount) returns both
    // targets with the override shadowing AGENTS.md; the second GET
    // (post-delete refetch) returns the override as gone and AGENTS.md now
    // active, exactly as the real backend would recompute it.
    let listCallCount = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch({
        list: () => {
          listCallCount++;
          if (listCallCount === 1) {
            return jsonResponse(200, [CODEX_AGENTS, CODEX_OVERRIDE]);
          }
          return jsonResponse(200, [
            { ...CODEX_AGENTS, status: "active" },
            makeTarget({
              id: "codex:project:override",
              agent: "codex",
              agentLabel: "Codex",
              fileName: "AGENTS.override.md",
            }),
          ]);
        },
        del: () => new Response(null, { status: 204 }),
      }),
    );
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("AGENTS.override.md"));
    expect(screen.getByText(/Shadowed/)).toBeInTheDocument();
    await user.click(screen.getByText("Delete"));

    expect(await screen.findByPlaceholderText(/doesn't exist yet/)).toBeInTheDocument();
    expect(listCallCount).toBe(2);
    // The sibling row, never directly touched by the delete, now shows the
    // refetched "Active" status instead of a stale "Shadowed".
    await user.click(screen.getByText("AGENTS.md"));
    expect(screen.getByText(/· Active/)).toBeInTheDocument();
  });

  it("shows an error message when saving fails, without losing the draft", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        list: () => jsonResponse(200, [CODEX_OVERRIDE]),
        write: () => jsonResponse(400, { message: "Content is too large" }),
      }),
    );
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("AGENTS.override.md"));
    const textarea = screen.getByDisplayValue("override rules");
    await user.type(textarea, " more");
    await user.click(screen.getByText("Save"));

    expect(await screen.findByText("Content is too large")).toBeInTheDocument();
    expect(screen.getByDisplayValue("override rules more")).toBeInTheDocument();
  });

  it("disables editing and shows a size notice for a truncated (too-large) file", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        list: () =>
          jsonResponse(200, [
            makeTarget({
              exists: true,
              truncated: true,
              size: 600 * 1024,
              status: "active",
              content: null,
            }),
          ]),
      }),
    );
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("CLAUDE.md"));
    expect(screen.getByText(/too large to/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});

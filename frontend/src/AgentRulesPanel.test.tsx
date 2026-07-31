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

  it("deletes an existing file via DELETE and clears the editor", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        list: () => jsonResponse(200, [CODEX_OVERRIDE]),
        del: () => new Response(null, { status: 204 }),
      }),
    );
    const user = userEvent.setup();
    render(<AgentRulesPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("AGENTS.override.md"));
    await user.click(screen.getByText("Delete"));

    expect(await screen.findByPlaceholderText(/doesn't exist yet/)).toBeInTheDocument();
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

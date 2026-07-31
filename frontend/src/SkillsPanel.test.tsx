// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillsPanel } from "./SkillsPanel.js";
import type { SkillInfo } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeSkill(overrides: Partial<SkillInfo> = {}): SkillInfo {
  return {
    name: "my-skill",
    description: "does a thing",
    sourceDir: "/repo/.claude/skills/my-skill",
    scope: "project",
    agents: ["claude-code"],
    enabledByAgent: { "claude-code": null },
    ...overrides,
  };
}

// Same "route by URL, unhandled requests reject loudly" convention as
// AgentRulesPanel.test.tsx's own mockFetch.
function mockFetch(list: () => Response | Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/skills") && method === "GET") {
      return Promise.resolve(list());
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

// Extends mockFetch with a PUT handler (issue #463) — `put` receives the
// parsed request body for assertions, `list` is called for every GET
// (including the refetch a successful toggle triggers).
function mockFetchWithToggle(
  list: () => Response | Promise<Response>,
  put: (body: unknown) => Response | Promise<Response>,
) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/skills") && method === "GET") {
      return Promise.resolve(list());
    }
    if (url.includes("/skills") && method === "PUT") {
      return Promise.resolve(put(JSON.parse(String(init?.body))));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("SkillsPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the list resolves", () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => new Promise(() => {})),
    );
    render(<SkillsPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("offers a manual Retry button on initial load failure, which succeeds on click", async () => {
    let attempt = 0;
    vi.stubGlobal(
      "fetch",
      mockFetch(() => {
        attempt++;
        if (attempt === 1) return Promise.reject(new Error("network error"));
        return jsonResponse(200, [makeSkill()]);
      }),
    );
    const user = userEvent.setup();
    render(<SkillsPanel params={{ projectId: 1 }} />);

    const retryButton = await screen.findByText("Retry");
    expect(screen.getByText("Couldn't load skills.")).toBeInTheDocument();

    await user.click(retryButton);

    expect(await screen.findByText("my-skill")).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows an empty state when no skills are discovered", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => jsonResponse(200, [])),
    );
    render(<SkillsPanel params={{ projectId: 1 }} />);
    expect(await screen.findByText(/No skills found/)).toBeInTheDocument();
  });

  it("groups skills by scope", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() =>
        jsonResponse(200, [
          makeSkill({ scope: "project", name: "proj-skill" }),
          makeSkill({
            scope: "global",
            name: "global-skill",
            sourceDir: "/home/x/.claude/skills/global-skill",
          }),
        ]),
      ),
    );
    render(<SkillsPanel params={{ projectId: 1 }} />);

    expect(await screen.findByText("Project")).toBeInTheDocument();
    expect(screen.getByText("Global")).toBeInTheDocument();
    expect(screen.getByText("proj-skill")).toBeInTheDocument();
    expect(screen.getByText("global-skill")).toBeInTheDocument();
  });

  it("selecting a skill shows its description and source directory", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() =>
        jsonResponse(200, [
          makeSkill({
            description: "a very useful skill",
            sourceDir: "/repo/.claude/skills/my-skill",
          }),
        ]),
      ),
    );
    const user = userEvent.setup();
    render(<SkillsPanel params={{ projectId: 1 }} />);

    await user.click(await screen.findByText("my-skill"));
    expect(screen.getByText("a very useful skill")).toBeInTheDocument();
    expect(screen.getByText("/repo/.claude/skills/my-skill")).toBeInTheDocument();
  });

  it("shows every agent that shares a skill's directory", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => jsonResponse(200, [makeSkill({ agents: ["claude-code", "opencode"] })])),
    );
    render(<SkillsPanel params={{ projectId: 1 }} />);
    expect(await screen.findByText("Claude Code, opencode")).toBeInTheDocument();
  });

  describe("enable/disable toggle (issue #463)", () => {
    it("shows no toggle for an agent whose enabledByAgent is null", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch(() => jsonResponse(200, [makeSkill({ agents: ["claude-code"] })])),
      );
      const user = userEvent.setup();
      render(<SkillsPanel params={{ projectId: 1 }} />);
      await user.click(await screen.findByText("my-skill"));
      expect(screen.queryByRole("button", { name: /skill enabled/ })).not.toBeInTheDocument();
    });

    it("shows a toggle for codex, and clicking it PUTs {agent, name, enabled} then reflects the refetched state", async () => {
      let putCount = 0;
      const fetchMock = mockFetchWithToggle(
        () =>
          jsonResponse(200, [
            makeSkill({
              agents: ["codex"],
              enabledByAgent: { codex: putCount === 0 },
            }),
          ]),
        (body) => {
          putCount++;
          expect(body).toEqual({ agent: "codex", name: "my-skill", enabled: false });
          return jsonResponse(
            200,
            makeSkill({ agents: ["codex"], enabledByAgent: { codex: false } }),
          );
        },
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<SkillsPanel params={{ projectId: 1 }} />);

      await user.click(await screen.findByText("my-skill"));
      expect(await screen.findByText("Codex: Enabled")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /Codex skill enabled/ }));

      expect(await screen.findByText("Codex: Disabled")).toBeInTheDocument();
      expect(putCount).toBe(1);
    });

    it("shows an error and leaves the toggle unchanged when the write fails", async () => {
      const fetchMock = mockFetchWithToggle(
        () =>
          jsonResponse(200, [makeSkill({ agents: ["codex"], enabledByAgent: { codex: true } })]),
        () => jsonResponse(409, { message: "ambiguous name" }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<SkillsPanel params={{ projectId: 1 }} />);

      await user.click(await screen.findByText("my-skill"));
      await user.click(screen.getByRole("button", { name: /Codex skill enabled/ }));

      expect(await screen.findByText("ambiguous name")).toBeInTheDocument();
      expect(screen.getByText("Codex: Enabled")).toBeInTheDocument();
    });
  });
});

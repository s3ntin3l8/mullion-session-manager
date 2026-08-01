// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Settings } from "./Settings.js";
import type { SkillInfo } from "./api.js";

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function mockFetch(list: () => Response | Promise<Response>) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/skills" && method === "GET") {
      return Promise.resolve(list());
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("Settings -> Skills", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the list resolves", () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => new Promise(() => {})),
    );
    render(<Settings onClose={vi.fn()} initialSection="skills" />);
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("shows an empty-state note when no global/builtin skills exist", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => jsonResponse(200, [])),
    );
    render(<Settings onClose={vi.fn()} initialSection="skills" />);
    expect(await screen.findByText(/No skills found/)).toBeInTheDocument();
  });

  it("lists discovered global/builtin skills", async () => {
    const skill: SkillInfo = {
      name: "skill-installer",
      description: "Install curated skills",
      sourceDir: "/home/x/.codex/skills/.system/skill-installer",
      scope: "global",
      agents: ["codex"],
      enabledByAgent: { codex: true },
    };
    vi.stubGlobal(
      "fetch",
      mockFetch(() => jsonResponse(200, [skill])),
    );
    render(<Settings onClose={vi.fn()} initialSection="skills" />);
    expect(await screen.findByText("skill-installer")).toBeInTheDocument();
    expect(screen.getByText(/Install curated skills/)).toBeInTheDocument();
  });

  it("shows a load-error state distinct from empty, on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => Promise.reject(new Error("network error"))),
    );
    render(<Settings onClose={vi.fn()} initialSection="skills" />);
    expect(await screen.findByText("Couldn't load skills.")).toBeInTheDocument();
  });
});

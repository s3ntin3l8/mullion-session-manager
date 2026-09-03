// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { jsonResponse } from "./test/jsonResponse.js";

function mockFetch(opts: {
  preview?: (body: unknown) => Response | Promise<Response>;
  apply?: (body: unknown) => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.endsWith("/setup/preview") && init?.method === "POST") {
      return Promise.resolve(
        opts.preview ? opts.preview(body) : new Response(null, { status: 500 }),
      );
    }
    if (url.endsWith("/setup/apply") && init?.method === "POST") {
      return Promise.resolve(opts.apply ? opts.apply(body) : new Response(null, { status: 500 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${init?.method} ${url}`));
  });
}

describe("ProjectSetupPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Preview until a slug is entered", () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);
    expect(screen.getByText("Preview")).toBeDisabled();
  });

  // Issue #942 (this restructure) — CLAUDE.md is unconditional (no
  // checkbox, no request-body field), so the only thing to guard against
  // drift is the notice copy that tells the user it's part of what gets
  // committed.
  it("the notice mentions CLAUDE.md as part of what gets committed", () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);
    expect(screen.getByText(/CLAUDE\.md/)).toBeInTheDocument();
  });

  it("sends the entered slug and checked options, and shows the returned diff", async () => {
    const fetchMock = mockFetch({
      preview: () =>
        jsonResponse(200, {
          previewId: "abc123",
          diff: "diff --git a/AGENTS.md b/AGENTS.md\n+new line\n",
          files: ["AGENTS.md", ".claude/skills/demo/SKILL.md"],
        }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByLabelText("Add a GEMINI.md pointer"));
    await user.click(screen.getByText("Preview"));

    expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
    const previewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/setup/preview"),
    );
    expect(previewCall).toBeDefined();
    const sentBody = JSON.parse((previewCall![1] as RequestInit).body as string);
    expect(sentBody).toEqual({
      slug: "demo",
      mirrors: ["GEMINI.md"],
      includeContributingPointer: false,
      symlinkAgentsSkills: false,
      includeDockConfig: false,
    });
    expect(screen.getByText(/\+new line/)).toBeInTheDocument();
  });

  it("shows an error and stays on the form when preview fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({ preview: () => jsonResponse(400, { message: '"x" is not a safe slug' }) }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "x");
    await user.click(screen.getByText("Preview"));

    expect(await screen.findByText('"x" is not a safe slug')).toBeInTheDocument();
    expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
  });

  it("Back returns to the form without re-fetching", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () => jsonResponse(200, { previewId: "abc", diff: "", files: ["AGENTS.md"] }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));
    await screen.findByText("Preview — 1 file");

    await user.click(screen.getByText("Back"));
    expect(screen.getByPlaceholderText("my-project")).toHaveValue("demo");
  });

  it("Apply opens a pull request and shows the link", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () => jsonResponse(200, { previewId: "abc", diff: "", files: ["AGENTS.md"] }),
        apply: () =>
          jsonResponse(200, {
            ok: true,
            mode: "pull-request",
            prUrl: "https://example.com/pr/1",
            prNumber: 1,
          }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));
    await screen.findByText("Preview — 1 file");
    await user.click(screen.getByText("Apply"));

    const link = await screen.findByText("PR #1");
    expect(link.closest("a")).toHaveAttribute("href", "https://example.com/pr/1");
  });

  it("Apply falls back to local-branch mode and shows the detail message", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () => jsonResponse(200, { previewId: "abc", diff: "", files: ["AGENTS.md"] }),
        apply: () =>
          jsonResponse(200, {
            ok: true,
            mode: "local-branch",
            branch: "mullion/setup-demo",
            detail: "No GitHub remote detected — committed locally, push it yourself when ready.",
          }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));
    await screen.findByText("Preview — 1 file");
    await user.click(screen.getByText("Apply"));

    expect(await screen.findByText("mullion/setup-demo")).toBeInTheDocument();
    expect(screen.getByText(/No GitHub remote detected/)).toBeInTheDocument();
  });

  it("shows an error and stays on the preview when apply fails", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () => jsonResponse(200, { previewId: "abc", diff: "", files: ["AGENTS.md"] }),
        apply: () => jsonResponse(500, { message: "push failed" }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));
    await screen.findByText("Preview — 1 file");
    await user.click(screen.getByText("Apply"));

    expect(await screen.findByText("push failed")).toBeInTheDocument();
    expect(screen.getByText("Apply")).toBeInTheDocument();
  });
});

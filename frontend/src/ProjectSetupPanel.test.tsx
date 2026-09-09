// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject } from "./test/fixtures.js";

function mockFetch(opts: {
  preview?: (body: unknown) => Response | Promise<Response>;
  apply?: (body: unknown) => Response | Promise<Response>;
  // Hermes review, PR #1200 round 3 (suggestion) — the panel now fetches
  // this on mount to drive its "(see the exact defaults)" disclosure;
  // defaults to a fixed literal here so every EXISTING test (which never
  // asserted on this text) keeps working unchanged.
  scaffoldDefaultsText?: string;
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
    if (url.endsWith("/api/workflow-conventions/scaffold-defaults")) {
      return Promise.resolve(
        jsonResponse(200, { text: opts.scaffoldDefaultsText ?? "Always branch and open a PR." }),
      );
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
    await user.click(screen.getByText("Preview"));

    expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
    const previewCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/setup/preview"),
    );
    expect(previewCall).toBeDefined();
    const sentBody = JSON.parse((previewCall![1] as RequestInit).body as string);
    expect(sentBody).toEqual({
      slug: "demo",
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

  // Issue #1201 — before this, the panel gave no indication of which
  // conventions text would land in the scaffolded AGENTS.md, and
  // computeScaffold's own fixed defaults could silently outrank whatever
  // was actually configured in Settings -> Sessions.
  describe("Workflow Conventions disclosure (issue #1201)", () => {
    const originalState = useDashboardStore.getState();
    afterEach(() => {
      useDashboardStore.setState(originalState, true);
    });

    it("names Mullion's built-in defaults when no conventions are configured yet", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        settings: {
          ...originalState.settings,
          sessions: { ...originalState.settings.sessions, workflowConventionsText: "" },
        },
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByText(/Mullion's own built-in defaults/)).toBeInTheDocument();
    });

    // Hermes review, PR #1200 round 3 (suggestion) — this disclosure used
    // to hand-copy a prose paraphrase of the actual defaults, which could
    // silently drift from mullion-scaffold.ts's own
    // SCAFFOLD_DEFAULT_WORKFLOW_ANSWERS. It now fetches the real text from
    // GET /api/workflow-conventions/scaffold-defaults (same source the
    // backend commits from) and shows it behind a "(see the exact
    // defaults)" toggle — this proves the fetched text actually reaches
    // the DOM, not just that the endpoint exists.
    it("surfaces the actual fetched scaffold-defaults text behind the disclosure toggle", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ scaffoldDefaultsText: "Never commit directly to the default branch." }),
      );
      useDashboardStore.setState({
        settings: {
          ...originalState.settings,
          sessions: { ...originalState.settings.sessions, workflowConventionsText: "" },
        },
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(
        await screen.findByText("Never commit directly to the default branch."),
      ).toBeInTheDocument();
    });

    it("names this install's own configured conventions when set", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        settings: {
          ...originalState.settings,
          sessions: {
            ...originalState.settings.sessions,
            workflowConventionsText: "Our team's own conventions.",
          },
        },
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByText(/This install's own conventions/)).toBeInTheDocument();
    });

    // Hermes review, PR #1200 round 2 — before this, the disclosure read
    // ONLY the install-wide settings text, ignoring this project's own
    // injectWorkflowConventions opt-out that resolveScaffoldWorkflowConventionsText
    // (project-setup.ts) already gates the SERVER-side resolution on. An
    // opted-out project with configured settings text got shown "the same
    // text already injected into every session on this project," which was
    // false on both counts: the server falls back to the fixed defaults for
    // exactly that project, ignoring this text entirely.
    it("names the built-in defaults, not the configured text, when this project has opted out of injection", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        settings: {
          ...originalState.settings,
          sessions: {
            ...originalState.settings.sessions,
            workflowConventionsText: "Our team's own conventions.",
          },
        },
        projects: [makeProject({ id: 1, injectWorkflowConventions: false })],
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByText(/opted out of workflow-conventions injection/)).toBeInTheDocument();
      expect(screen.getByText(/Mullion's own built-in defaults/)).toBeInTheDocument();
      expect(screen.queryByText(/Our team's own conventions\./)).not.toBeInTheDocument();
    });

    it("still names this install's own configured conventions when injectWorkflowConventions is explicitly true (not just the null default)", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        settings: {
          ...originalState.settings,
          sessions: {
            ...originalState.settings.sessions,
            workflowConventionsText: "Our team's own conventions.",
          },
        },
        projects: [makeProject({ id: 1, injectWorkflowConventions: true })],
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByText(/This install's own conventions/)).toBeInTheDocument();
    });
  });

  it("warns when the preview reports an existing AGENTS.override.md, without blocking Apply", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () =>
          jsonResponse(200, {
            previewId: "abc123",
            diff: "diff --git a/AGENTS.md b/AGENTS.md\n+new line\n",
            files: ["AGENTS.md"],
            hasAgentsOverride: true,
          }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));

    // The warning text mentions AGENTS.override.md twice (once in a <code>
    // element, once in plain prose) — findAllByText, not findByText, since
    // a single-match query would throw on the ambiguity.
    expect((await screen.findAllByText(/AGENTS\.override\.md/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/codex reads that file/)).toBeInTheDocument();
    expect(screen.getByText("Apply")).not.toBeDisabled();
  });

  it("shows no override warning when the preview reports none", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        preview: () =>
          jsonResponse(200, {
            previewId: "abc123",
            diff: "diff --git a/AGENTS.md b/AGENTS.md\n+new line\n",
            files: ["AGENTS.md"],
            hasAgentsOverride: false,
          }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);

    await user.type(screen.getByPlaceholderText("my-project"), "demo");
    await user.click(screen.getByText("Preview"));
    await screen.findByText("Preview — 1 file");

    expect(screen.queryByText(/AGENTS\.override\.md/)).not.toBeInTheDocument();
  });

  // Issue #1205, Phase 3 (drift detection) — the banner is driven by
  // project.conventionsDrifted, computed server-side (routes/projects.ts),
  // never re-derived here.
  describe("conventions drift banner (Phase 3)", () => {
    const originalState = useDashboardStore.getState();
    afterEach(() => {
      useDashboardStore.setState(originalState, true);
    });

    it("shows the drift banner when the project's conventions have drifted", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, conventionsDrifted: true })],
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(
        screen.getByText(/re-run Preview and Apply below to update the committed text/),
      ).toBeInTheDocument();
    });

    it("shows no drift banner when the project has not drifted", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, conventionsDrifted: false })],
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(
        screen.queryByText(/re-run Preview and Apply below to update the committed text/),
      ).not.toBeInTheDocument();
    });
  });
});

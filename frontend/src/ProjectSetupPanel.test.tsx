// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";
import { makeProject } from "./test/fixtures.js";

function mockFetch(opts: {
  preview?: (body: unknown) => Response | Promise<Response>;
  apply?: (body: unknown) => Response | Promise<Response>;
  generate?: (body: unknown) => Response | Promise<Response>;
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
    if (url.endsWith("/setup/generate") && init?.method === "POST") {
      return Promise.resolve(
        opts.generate ? opts.generate(body) : new Response(null, { status: 500 }),
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

// The panel opens on the agent path; the starter-template Preview lives behind
// the path switch (#2428).
async function toTemplatePath(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("radio", { name: "Starter template" }));
}

describe("ProjectSetupPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    // A 429 trips the per-endpoint breaker (api/client.ts), which would
    // short-circuit any later test that generates for the same project.
    __resetRateLimitBreakerForTests();
  });

  describe("Generate with agent", () => {
    const generated = (extra: Record<string, unknown> = {}) =>
      jsonResponse(200, {
        previewId: "gen1",
        diff: "diff --git a/AGENTS.md b/AGENTS.md\n+generated line\n",
        files: ["AGENTS.md", ".claude/skills/demo/SKILL.md"],
        hasAgentsOverride: false,
        sandboxed: true,
        ...extra,
      });

    it("is disabled until a slug is entered", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByRole("button", { name: /^Generate with / })).toBeDisabled();
    });

    it("posts the entered options to /setup/generate and shows the same diff view", async () => {
      const fetchMock = mockFetch({ generate: () => generated() });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));

      expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
      expect(screen.getByText(/\+generated line/)).toBeInTheDocument();
      const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/setup/generate"));
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({
        slug: "demo",
        includeContributingPointer: false,
        symlinkAgentsSkills: false,
        includeDockConfig: false,
      });
      expect(screen.queryByText(/without a sandbox/)).not.toBeInTheDocument();
    });

    it("warns when the turn ran unsandboxed and when it looks generic", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ generate: () => generated({ sandboxed: false, possiblyGeneric: true }) }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));
      expect(await screen.findByText(/without a sandbox/)).toBeInTheDocument();
      expect(screen.getByText(/may not have read this repo/)).toBeInTheDocument();
    });

    it("on a 409 offers regenerate checkboxes and retries with refresh", async () => {
      let calls = 0;
      const fetchMock = mockFetch({
        generate: () => {
          calls += 1;
          return calls === 1 ? jsonResponse(409, { message: "already exist" }) : generated();
        },
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));

      expect(await screen.findByText(/already exist/)).toBeInTheDocument();
      // Retrying with nothing ticked would just 409 again.
      expect(screen.getByRole("button", { name: /^Generate with / })).toBeDisabled();
      await user.click(screen.getByLabelText("Regenerate the skill"));
      await user.click(screen.getByLabelText("Regenerate the reviewer"));
      await user.click(screen.getByRole("button", { name: /^Generate with / }));

      expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
      const generateCalls = fetchMock.mock.calls.filter(([url]) =>
        String(url).endsWith("/setup/generate"),
      );
      expect(JSON.parse((generateCalls[1][1] as RequestInit).body as string).refresh).toEqual([
        "skill",
        "reviewer",
      ]);
    });

    it("drops the regenerate choice when the slug changes", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ generate: () => jsonResponse(409, { message: "already exist" }) }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "a");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));
      await user.click(await screen.findByLabelText("Regenerate the skill"));

      await user.type(screen.getByPlaceholderText("my-project"), "b");
      expect(screen.queryByLabelText("Regenerate the skill")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Generate with / })).toBeEnabled();
    });

    it("starts only one agent turn for a double click", async () => {
      let release!: (r: Response) => void;
      const fetchMock = mockFetch({
        generate: () => new Promise<Response>((resolve) => (release = resolve)) as never,
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      const button = screen.getByRole("button", { name: /^Generate with / });
      await user.dblClick(button);
      release(generated());
      await screen.findByText("Preview — 2 files");
      expect(
        fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/setup/generate")),
      ).toHaveLength(1);
    });

    describe("existing instructions choice", () => {
      async function generateWith(mode: string | null, extra: Record<string, unknown> = {}) {
        const fetchMock = mockFetch({ generate: () => generated(extra) });
        vi.stubGlobal("fetch", fetchMock);
        const user = userEvent.setup();
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await user.type(screen.getByPlaceholderText("my-project"), "demo");
        if (mode) await user.click(screen.getByLabelText(mode));
        await user.click(screen.getByRole("button", { name: /^Generate with / }));
        await screen.findByText("Preview — 2 files");
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/setup/generate"));
        return JSON.parse((call![1] as RequestInit).body as string) as Record<string, unknown>;
      }

      it("defaults to leaving existing content alone and sends no mode", async () => {
        const fetchMock = mockFetch({ generate: () => generated() });
        vi.stubGlobal("fetch", fetchMock);
        const user = userEvent.setup();
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        expect(screen.getByLabelText("Leave it")).toBeChecked();
        await user.type(screen.getByPlaceholderText("my-project"), "demo");
        await user.click(screen.getByRole("button", { name: /^Generate with / }));
        await screen.findByText("Preview — 2 files");
        const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/setup/generate"));
        expect(JSON.parse((call![1] as RequestInit).body as string).existingInstructions).toBe(
          undefined,
        );
      });

      it("sends the chosen mode", async () => {
        expect((await generateWith("Restructure it")).existingInstructions).toBe("restructure");
      });

      it("report lists the conflicts, with the count of unreadable lines", async () => {
        await generateWith("Tell me about conflicts", {
          conflicts: [
            {
              file: "AGENTS.md",
              excerpt: "comment @bot Review",
              kind: "contradicts",
              note: "re-review by @mention is forbidden",
            },
          ],
          droppedConflictLines: 2,
        });
        expect(screen.getByText(/1 passage outside Mullion/)).toBeInTheDocument();
        expect(screen.getByText(/comment @bot Review/)).toBeInTheDocument();
        expect(
          screen.getByText(/2 more lines from the agent could not be read/),
        ).toBeInTheDocument();
      });

      it("report where every line was unreadable is not an all-clear", async () => {
        await generateWith("Tell me about conflicts", { conflicts: [], droppedConflictLines: 3 });
        expect(screen.getByText(/3 lines that could not be read/)).toBeInTheDocument();
        expect(screen.queryByText(/No existing instructions conflict/)).not.toBeInTheDocument();
      });

      it("report with nothing found says so", async () => {
        await generateWith("Tell me about conflicts", { conflicts: [] });
        expect(screen.getByText(/No existing instructions conflict/)).toBeInTheDocument();
      });

      it("restructure warns about a lossy rewrite and otherwise asks for a check", async () => {
        await generateWith("Restructure it", { possiblyLossy: true });
        expect(screen.getByText(/much shorter than the original/)).toBeInTheDocument();
      });

      it("restructure without the lossy signal still prompts a review", async () => {
        await generateWith("Restructure it");
        expect(screen.getByText(/AGENTS.md is restructured below/)).toBeInTheDocument();
        expect(screen.queryByText(/much shorter than the original/)).not.toBeInTheDocument();
      });

      it("shows no conflict or restructure notices for a plain generate", async () => {
        await generateWith(null);
        expect(screen.queryByText(/outside Mullion/)).not.toBeInTheDocument();
        expect(screen.queryByText(/restructured below/)).not.toBeInTheDocument();
      });

      it("renders the mode description outside .settings-row-control while keeping radiogroup labelling and disabling while generating", async () => {
        let release!: (r: Response) => void;
        vi.stubGlobal(
          "fetch",
          mockFetch({
            generate: () => new Promise<Response>((resolve) => (release = resolve)) as never,
          }),
        );
        const user = userEvent.setup();
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);

        const radiogroup = screen.getByRole("radiogroup", {
          name: "Instructions this repo already has",
        });
        expect(radiogroup).toHaveClass("settings-row-control");
        expect(radiogroup).toHaveAttribute("aria-labelledby", "setup-existing-instructions-label");
        expect(radiogroup).toHaveAttribute("aria-describedby", "setup-existing-instructions-desc");

        const desc = document.getElementById("setup-existing-instructions-desc");
        expect(desc).not.toBeNull();
        expect(desc).toHaveTextContent(/everything else stays as written/);
        expect(radiogroup.contains(desc)).toBe(false);
        const row = radiogroup.closest(".settings-row");
        expect(row).toHaveStyle({ flexWrap: "wrap" });
        expect(row?.querySelector(".settings-row-text")).toHaveStyle({
          minWidth: "min(100%, 230px)",
        });

        await user.click(screen.getByLabelText("Tell me about conflicts"));
        expect(desc).toHaveTextContent(/Nothing is rewritten/);

        await user.type(screen.getByPlaceholderText("my-project"), "demo");
        await user.click(screen.getByRole("button", { name: /^Generate with / }));
        for (const radio of within(radiogroup).getAllByRole("radio")) {
          expect(radio).toBeDisabled();
        }
        release(generated());
        await screen.findByText("Preview — 2 files");
      });
    });

    it("shows an error and stays on the form when generation fails", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({ generate: () => jsonResponse(500, { message: "agent exploded" }) }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));
      expect(await screen.findByText(/agent exploded/)).toBeInTheDocument();
      expect(screen.getByPlaceholderText("my-project")).toBeInTheDocument();
    });

    it("explains a rate limit instead of showing the raw error", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          generate: () =>
            new Response(JSON.stringify({ message: "Rate limit exceeded" }), {
              status: 429,
              headers: { "Retry-After": "600", "Content-Type": "application/json" },
            }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));
      expect(
        await screen.findByText(/rate limited — try again in about 10 minute/),
      ).toBeInTheDocument();
    });
  });

  it("disables Preview until a slug is entered", async () => {
    vi.stubGlobal("fetch", mockFetch({}));
    render(<ProjectSetupPanel params={{ projectId: 1 }} />);
    await toTemplatePath(userEvent.setup());
    expect(screen.getByText("Preview starter template")).toBeDisabled();
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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));

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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));

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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));
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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));
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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));
    await screen.findByText("Preview — 1 file");
    await user.click(screen.getByText("Apply"));

    expect(await screen.findByText("mullion/setup-demo")).toBeInTheDocument();
    expect(screen.getByText(/No GitHub remote detected/)).toBeInTheDocument();
  });

  // Hermes review, PR #1206 round 2 (suggestion) — before this, a
  // successful apply left the store's project.conventionsDrifted stale
  // until the next unrelated /api/projects poll, so the drift banner could
  // briefly persist through "Scaffold another" even right after the fix
  // apply that resolved it.
  it("refreshes the project list after a successful apply, so a resolved drift banner doesn't linger stale", async () => {
    const originalState = useDashboardStore.getState();
    const refreshProjects = vi.fn().mockResolvedValue(undefined);
    useDashboardStore.setState({ refreshProjects });
    try {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          preview: () => jsonResponse(200, { previewId: "abc", diff: "", files: ["AGENTS.md"] }),
          apply: () =>
            jsonResponse(200, {
              ok: true,
              mode: "local-branch",
              branch: "mullion/setup-demo",
              detail: "committed locally",
            }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await toTemplatePath(user);
      await user.click(screen.getByText("Preview starter template"));
      await screen.findByText("Preview — 1 file");
      expect(refreshProjects).not.toHaveBeenCalled();

      await user.click(screen.getByText("Apply"));
      await screen.findByText("mullion/setup-demo");

      expect(refreshProjects).toHaveBeenCalledTimes(1);
    } finally {
      useDashboardStore.setState(originalState, true);
    }
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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));
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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));

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
    await toTemplatePath(user);
    await user.click(screen.getByText("Preview starter template"));
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
  // Issue #2428 — the instructions choice and the agent belong to one path.
  describe("agent and template paths", () => {
    const generated = () =>
      jsonResponse(200, {
        previewId: "gen1",
        diff: "diff --git a/AGENTS.md b/AGENTS.md\n+x\n",
        files: ["AGENTS.md"],
        hasAgentsOverride: false,
        sandboxed: true,
      });

    it("opens on the agent path: the radio, the agent line and a Generate button naming the agent", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, defaultAgent: "codex" })],
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByRole("radio", { name: "Write it with an agent" })).toBeChecked();
      expect(
        screen.getByRole("radiogroup", { name: "Instructions this repo already has" }),
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Generate with codex" })).toBeInTheDocument();
      expect(screen.queryByText("Preview starter template")).not.toBeInTheDocument();
    });

    it("the template path hides the instructions choice and offers only the starter Preview", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await toTemplatePath(user);
      expect(
        screen.queryByRole("radiogroup", { name: "Instructions this repo already has" }),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Preview starter template")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /^Generate with / })).not.toBeInTheDocument();
    });

    it("keeps the chosen instructions mode when switching away and back", async () => {
      vi.stubGlobal("fetch", mockFetch({}));
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.click(screen.getByLabelText("Restructure it"));
      await toTemplatePath(user);
      await user.click(screen.getByRole("radio", { name: "Write it with an agent" }));
      expect(screen.getByLabelText("Restructure it")).toBeChecked();
    });

    it("says on the form that a pull request is opened and nothing is overwritten", () => {
      vi.stubGlobal("fetch", mockFetch({}));
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      expect(screen.getByText(/nothing in your checkout is overwritten/)).toBeInTheDocument();
    });

    it("names the source of a generated preview, with the agent and the mode", async () => {
      vi.stubGlobal("fetch", mockFetch({ generate: () => generated() }));
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, defaultAgent: "codex" })],
      });
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByLabelText("Restructure it"));
      await user.click(screen.getByRole("button", { name: "Generate with codex" }));
      expect(await screen.findByTestId("preview-source")).toHaveTextContent(
        "Generated by codex · Restructure it",
      );
    });

    it("names a starter-template preview as such", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          preview: () =>
            jsonResponse(200, {
              previewId: "p1",
              diff: "diff --git a/AGENTS.md b/AGENTS.md\n+x\n",
              files: ["AGENTS.md"],
              hasAgentsOverride: false,
            }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await toTemplatePath(user);
      await user.click(screen.getByText("Preview starter template"));
      expect(await screen.findByTestId("preview-source")).toHaveTextContent("Starter template");
    });
  });
});

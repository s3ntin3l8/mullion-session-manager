// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectBriefingPanel } from "./ProjectBriefingPanel.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { makeProject } from "./test/fixtures.js";
import { useDashboardStore } from "./store/index.js";

// Same "route a mocked fetch by URL/method, unhandled requests reject
// loudly" convention as AgentRulesPanel.test.tsx's own mockFetch — this
// panel has one GET over the combined row, plus an independent PUT/DELETE
// per field (base `/tooling` for briefing, `/tooling/skill`,
// `/tooling/reviewer-agent` — PR-5). `write`/`del` handle the base
// briefing path; `writeSkill`/`delSkill`/`writeReviewerAgent`/
// `delReviewerAgent` are checked first so a test can distinguish which
// field's PUT/DELETE actually fired.
function mockFetch(opts: {
  get?: () => Response | Promise<Response>;
  write?: (body: unknown) => Response | Promise<Response>;
  del?: () => Response | Promise<Response>;
  writeSkill?: (body: unknown) => Response | Promise<Response>;
  delSkill?: () => Response | Promise<Response>;
  writeReviewerAgent?: (body: unknown) => Response | Promise<Response>;
  delReviewerAgent?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.endsWith("/tooling") && method === "GET") {
      return Promise.resolve(opts.get ? opts.get() : new Response(null, { status: 200 }));
    }
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.endsWith("/tooling/skill") && method === "PUT") {
      return Promise.resolve(
        opts.writeSkill ? opts.writeSkill(body) : new Response(null, { status: 500 }),
      );
    }
    if (url.endsWith("/tooling/skill") && method === "DELETE") {
      return Promise.resolve(opts.delSkill ? opts.delSkill() : new Response(null, { status: 204 }));
    }
    if (url.endsWith("/tooling/reviewer-agent") && method === "PUT") {
      return Promise.resolve(
        opts.writeReviewerAgent
          ? opts.writeReviewerAgent(body)
          : new Response(null, { status: 500 }),
      );
    }
    if (url.endsWith("/tooling/reviewer-agent") && method === "DELETE") {
      return Promise.resolve(
        opts.delReviewerAgent ? opts.delReviewerAgent() : new Response(null, { status: 204 }),
      );
    }
    if (url.endsWith("/tooling") && method === "PUT") {
      return Promise.resolve(opts.write ? opts.write(body) : new Response(null, { status: 500 }));
    }
    if (url.endsWith("/tooling") && method === "DELETE") {
      return Promise.resolve(opts.del ? opts.del() : new Response(null, { status: 204 }));
    }
    return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
  });
}

describe("ProjectBriefingPanel", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a loading state before the briefing resolves", () => {
    vi.stubGlobal("fetch", mockFetch({ get: () => new Promise(() => {}) }));
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);
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
          return jsonResponse(200, {
            briefing: "existing briefing",
            skill: null,
            reviewerAgent: null,
          });
        },
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const retryButton = await screen.findByText("Retry");
    expect(screen.getByText("Couldn't load this project's Mullion tooling.")).toBeInTheDocument();

    await user.click(retryButton);

    expect(await screen.findByDisplayValue("existing briefing")).toBeInTheDocument();
    expect(attempt).toBe(2);
  });

  it("shows an empty, placeholder-guided editor when the project has no DB briefing yet", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
      }),
    );
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No pinned note set/);
    expect(textarea).toHaveValue("");
    // No row exists yet, so there's nothing to delete.
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("loads an existing briefing into the editor and offers Delete", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () =>
          jsonResponse(200, {
            briefing: "operator instructions",
            skill: null,
            reviewerAgent: null,
          }),
      }),
    );
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    expect(await screen.findByDisplayValue("operator instructions")).toBeInTheDocument();
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  it("saves edited content via PUT and reflects the updated value", async () => {
    const fetchMock = mockFetch({
      get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
      write: (body) => jsonResponse(200, { briefing: (body as { briefing: string }).briefing }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No pinned note set/);
    await user.type(textarea, "new briefing text");

    const saveButton = screen.getByText("Save");
    expect(saveButton).not.toBeDisabled();
    await user.click(saveButton);

    expect(await screen.findByText("Save")).toBeDisabled();
    const putCall = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PUT",
    );
    expect(putCall).toBeDefined();
    expect(JSON.parse((putCall![1] as RequestInit).body as string)).toEqual({
      briefing: "new briefing text",
    });
    // Delete now appears — the panel treats the just-saved row as existing.
    expect(screen.getByText("Delete")).toBeInTheDocument();
  });

  // Same "don't unconditionally clear dirty" guard as AgentRulesPanel's own
  // handleSave (Hermes review, PR #458) — a save in flight must not silently
  // mark keystrokes typed during the round trip as saved.
  it("keeps dirty (and Save enabled) if the draft changed again while a save was in flight", async () => {
    let resolveWrite: (res: Response) => void;
    const writePromise = new Promise<Response>((resolve) => {
      resolveWrite = resolve;
    });
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "base", skill: null, reviewerAgent: null }),
        write: () => writePromise,
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " first edit");
    await user.click(screen.getByText("Save"));
    expect(screen.getByText("Saving…")).toBeInTheDocument();

    await user.type(textarea, " more");

    resolveWrite!(jsonResponse(200, { briefing: "base first edit" }));
    await screen.findByText("Save");

    expect(screen.getByText("Save")).not.toBeDisabled();
    expect(screen.getByDisplayValue("base first edit more")).toBeInTheDocument();
  });

  it("deletes the row via DELETE, clearing the editor to the empty/no-briefing state", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () =>
          jsonResponse(200, { briefing: "to be deleted", skill: null, reviewerAgent: null }),
        del: () => new Response(null, { status: 204 }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    await screen.findByDisplayValue("to be deleted");
    // ConfirmButton requires arming before it fires — same "click again to
    // confirm" pattern as AgentRulesPanel's own delete button.
    const deleteButton = screen.getByTitle(/Delete this project's pinned note\?/);
    await user.click(deleteButton);
    await user.click(deleteButton);

    expect(await screen.findByPlaceholderText(/No pinned note set/)).toBeInTheDocument();
    expect(screen.queryByText("Delete")).not.toBeInTheDocument();
  });

  it("requires arming before firing — a single click does not delete", async () => {
    const delSpy = vi.fn(() => new Response(null, { status: 204 }));
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "content", skill: null, reviewerAgent: null }),
        del: delSpy,
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    await screen.findByDisplayValue("content");
    await user.click(screen.getByTitle(/Delete this project's pinned note\?/));
    expect(delSpy).not.toHaveBeenCalled();
  });

  it("shows an error message when saving fails, without losing the draft", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "base", skill: null, reviewerAgent: null }),
        write: () => jsonResponse(400, { message: "Briefing is too large" }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " more");
    await user.click(screen.getByText("Save"));

    expect(await screen.findByText("Briefing is too large")).toBeInTheDocument();
    expect(screen.getByDisplayValue("base more")).toBeInTheDocument();
  });

  // Hermes review, PR #893 — the byte cap used to be invisible until Save
  // 400s with a byte count.
  it("shows a live byte-count hint and disables Save once the draft exceeds the byte cap", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByPlaceholderText(/No pinned note set/);
    await user.type(textarea, "short");
    expect(screen.getByText(/5 \/ 512 bytes/)).toBeInTheDocument();
    expect(screen.getByText("Save")).not.toBeDisabled();

    await user.paste("a".repeat(513));
    expect(await screen.findByText(/over the limit/)).toBeInTheDocument();
    expect(screen.getByText("Save")).toBeDisabled();
  });

  it("Discard restores the last-saved value and disables itself", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch({
        get: () => jsonResponse(200, { briefing: "base", skill: null, reviewerAgent: null }),
      }),
    );
    const user = userEvent.setup();
    render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

    const textarea = await screen.findByDisplayValue("base");
    await user.type(textarea, " edited");
    expect(screen.getByText("Discard")).toBeInTheDocument();

    await user.click(screen.getByText("Discard"));
    expect(screen.getByDisplayValue("base")).toBeInTheDocument();
    expect(screen.queryByText("Discard")).not.toBeInTheDocument();
  });

  // PR-5 — skill/reviewerAgent are independent DB columns on the same
  // project_tooling row, switched between via the field list on the left
  // (reusing AgentRulesPanel's own target-list shell).
  describe("skill and reviewer agent fields", () => {
    it("switches between fields, each showing its own saved value", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () =>
            jsonResponse(200, {
              briefing: "the briefing",
              skill: "---\nname: s\ndescription: d\n---\nskill body",
              reviewerAgent: null,
            }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByDisplayValue("the briefing");

      await user.click(screen.getByText("Skill"));
      expect(await screen.findByPlaceholderText(/No project skill set yet/)).toHaveValue(
        "---\nname: s\ndescription: d\n---\nskill body",
      );

      await user.click(screen.getByText("Reviewer agent"));
      expect(
        await screen.findByPlaceholderText(/No project reviewer subagent set yet/),
      ).toHaveValue("");
    });

    it("saves the skill field via PUT /tooling/skill, independent of briefing", async () => {
      const fetchMock = mockFetch({
        get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        writeSkill: (body) => jsonResponse(200, { skill: (body as { skill: string }).skill }),
      });
      vi.stubGlobal("fetch", fetchMock);
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByPlaceholderText(/No pinned note set/);
      await user.click(screen.getByText("Skill"));
      const textarea = await screen.findByPlaceholderText(/No project skill set yet/);
      await user.type(textarea, "---\nname: x\ndescription: d\n---\nbody");
      await user.click(screen.getByText("Save"));

      const putCall = fetchMock.mock.calls.find(
        ([url, init]) =>
          String(url).endsWith("/tooling/skill") &&
          (init as RequestInit | undefined)?.method === "PUT",
      );
      expect(putCall).toBeDefined();
      await screen.findByText("Delete");
    });

    it("deletes only the reviewer agent field, leaving the panel on that field cleared", async () => {
      const delSpy = vi.fn(() => new Response(null, { status: 204 }));
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () =>
            jsonResponse(200, {
              briefing: "keep",
              skill: null,
              reviewerAgent: "---\nname: r\ndescription: d\n---\nreview body",
            }),
          delReviewerAgent: delSpy,
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByDisplayValue("keep");
      await user.click(screen.getByText("Reviewer agent"));
      expect(
        await screen.findByPlaceholderText(/No project reviewer subagent set yet/),
      ).toHaveValue("---\nname: r\ndescription: d\n---\nreview body");

      const deleteButton = screen.getByTitle(/Delete this project's reviewer agent\?/);
      await user.click(deleteButton);
      await user.click(deleteButton);

      expect(delSpy).toHaveBeenCalledTimes(1);
      expect(
        await screen.findByPlaceholderText(/No project reviewer subagent set yet/),
      ).toBeInTheDocument();
    });

    it("fills the textarea from the starter template without touching the saved value until Save", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByPlaceholderText(/No pinned note set/);
      await user.click(screen.getByText("Skill"));
      await screen.findByPlaceholderText(/No project skill set yet/);

      await user.click(screen.getByText("Use starter template"));
      expect(screen.getByDisplayValue(/name: my-project-skill/)).toBeInTheDocument();
      expect(screen.getByText("Save")).not.toBeDisabled();
    });

    it("disables switching to another field while the current one has unsaved changes", async () => {
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: "base", skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      const textarea = await screen.findByDisplayValue("base");
      await user.type(textarea, " edited");

      expect(screen.getByRole("button", { name: /Skill/ })).toBeDisabled();
    });
  });

  // Issue #884 — the per-project injectAgentGuide/injectProjectBriefing
  // override row, reusing GitPanel.tsx's own toggle+inherited+reset
  // pattern. Reads project/settings straight off the dashboard store
  // (no fetch of its own), so these tests seed the store directly rather
  // than mocking a network call for this part.
  describe("session injection overrides", () => {
    const originalState = useDashboardStore.getState();

    afterEach(() => {
      useDashboardStore.setState(originalState, true);
    });

    it("shows both fields as inherited when the project has no override", async () => {
      useDashboardStore.setState({ projects: [makeProject({ id: 1 })] });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Agent guide");
      // Three inherited chips — one per field (including issue #937's
      // Workflow conventions row) — since none is overridden.
      expect(screen.getAllByTitle("Inherited from the global setting")).toHaveLength(3);
    });

    it("shows an explicit override with a reset button, not the inherited chip", async () => {
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, injectAgentGuide: false })],
      });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Agent guide");
      // Only the two OTHER fields (injectProjectBriefing/
      // injectWorkflowConventions, still null) are inherited.
      expect(screen.getAllByTitle("Inherited from the global setting")).toHaveLength(2);
      expect(screen.getByTitle("Reset to the global default")).toBeInTheDocument();
    });

    it("clicking the toggle calls updateProject with the new explicit value", async () => {
      useDashboardStore.setState({ projects: [makeProject({ id: 1 })] });
      const updateProject = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ updateProject });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Agent guide");
      // Both toggles default to "on" (inherited true) — clicking flips to
      // an explicit false, the opposite of the current effective value.
      const toggles = screen.getAllByRole("button", { name: /Agent guide|Project briefing/ });
      await user.click(toggles[0]);

      expect(updateProject).toHaveBeenCalledWith(1, { injectAgentGuide: false });
    });

    it("clicking the reset button calls updateProject with null", async () => {
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, injectProjectBriefing: true })],
      });
      const updateProject = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ updateProject });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Project briefing");
      await user.click(screen.getByTitle("Reset to the global default"));

      expect(updateProject).toHaveBeenCalledWith(1, { injectProjectBriefing: null });
    });

    // Issue #937 — same pattern as the injectAgentGuide/injectProjectBriefing
    // rows above, but with no global boolean setting to read (see
    // ProjectBriefingPanel.tsx's own comment: `null` always inherits `true`).
    it("shows the Workflow conventions row and toggles it to an explicit value", async () => {
      useDashboardStore.setState({ projects: [makeProject({ id: 1 })] });
      const updateProject = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ updateProject });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Workflow conventions");
      const toggle = screen.getByRole("button", { name: "Workflow conventions" });
      await user.click(toggle);

      expect(updateProject).toHaveBeenCalledWith(1, { injectWorkflowConventions: false });
    });

    it("clicking the Workflow conventions reset button calls updateProject with null", async () => {
      useDashboardStore.setState({
        projects: [makeProject({ id: 1, injectWorkflowConventions: true })],
      });
      const updateProject = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ updateProject });
      vi.stubGlobal(
        "fetch",
        mockFetch({
          get: () => jsonResponse(200, { briefing: null, skill: null, reviewerAgent: null }),
        }),
      );
      const user = userEvent.setup();
      render(<ProjectBriefingPanel params={{ projectId: 1 }} />);

      await screen.findByText("Workflow conventions");
      await user.click(screen.getByTitle("Reset to the global default"));

      expect(updateProject).toHaveBeenCalledWith(1, { injectWorkflowConventions: null });
    });
  });
});

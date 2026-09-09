// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "../../Settings.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/index.js";
import { jsonResponse } from "../../test/jsonResponse.js";

// Issue #937 — same fake-in-memory-backend pattern as
// Settings.sessions.test.tsx's own suites: a fake server over global
// fetch, not a mocked store, so the real updateSettings()/PATCH wiring is
// what's under test.

describe("Settings -> Sessions -> Workflow conventions textarea", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            enabled: true,
            bundleHash: "stub-hash",
            manifestPath: "/home/user/.mullion/sync-manifest.json",
            clis: [],
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the current value and updates the store immediately on change", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const textarea = await screen.findByPlaceholderText(/No workflow conventions configured yet/);
    expect(textarea).toHaveValue("");

    await user.type(textarea, "always branch");

    expect(useDashboardStore.getState().settings.sessions.workflowConventionsText).toBe(
      "always branch",
    );
  });

  it("PATCHes /api/settings with the changed field, debounced", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    const textarea = await screen.findByPlaceholderText(/No workflow conventions configured yet/);
    await user.type(textarea, "x");

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ sessions: { workflowConventionsText: "x" } }),
        }),
      ),
    );
  });
});

describe("Settings -> Sessions -> workflow-conventions wizard", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const QUESTIONS = [
    {
      id: "branching",
      question: "Direct commits, or always branch + PR?",
      options: [
        { id: "branch-pr", label: "Always branch + PR", fragment: "Always branch and open a PR." },
        {
          id: "direct-commit",
          label: "Direct commits are fine",
          fragment: "Direct commits are fine.",
        },
      ],
    },
  ];

  beforeEach(() => {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/workflow-conventions/questions" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { questions: QUESTIONS }));
      }
      if (url === "/api/workflow-conventions/preview" && method === "POST") {
        return Promise.resolve(jsonResponse(200, { text: "Always branch and open a PR." }));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            enabled: true,
            bundleHash: "stub-hash",
            manifestPath: "/home/user/.mullion/sync-manifest.json",
            clis: [],
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);

    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the wizard, walks through a question, previews, and applies the result to the textarea", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));

    expect(await screen.findByText("Direct commits, or always branch + PR?")).toBeInTheDocument();

    await user.click(screen.getByText("Always branch + PR"));
    await user.click(screen.getByText("Preview"));

    expect(
      await screen.findByText(/This replaces your current workflow conventions text/),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Replace current text"));

    await waitFor(() =>
      expect(useDashboardStore.getState().settings.sessions.workflowConventionsText).toBe(
        "Always branch and open a PR.",
      ),
    );

    // The modal closes after applying.
    expect(screen.queryByText("Generate workflow conventions")).not.toBeInTheDocument();
  });

  it("cancelling the wizard (Escape) leaves the textarea untouched", async () => {
    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Direct commits, or always branch + PR?");

    fireEvent.keyDown(screen.getByRole("dialog", { name: "Generate workflow conventions" }), {
      key: "Escape",
    });

    await waitFor(() =>
      expect(screen.queryByText("Generate workflow conventions")).not.toBeInTheDocument(),
    );
    expect(useDashboardStore.getState().settings.sessions.workflowConventionsText).toBe("");
  });

  // Regression for a review finding: a rejected preview request used to
  // leave `previewText` at null with nothing rendering `previewError` at
  // all, so clicking "Preview" after a failure silently did nothing.
  it("shows an error (not a silent no-op) when the preview request fails, and Retry recovers", async () => {
    let previewCalls = 0;
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, DEFAULT_SETTINGS));
      }
      if (url === "/api/workflow-conventions/questions" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { questions: QUESTIONS }));
      }
      if (url === "/api/workflow-conventions/preview" && method === "POST") {
        previewCalls += 1;
        return previewCalls === 1
          ? Promise.resolve(jsonResponse(500, { message: "boom" }))
          : Promise.resolve(jsonResponse(200, { text: "Always branch and open a PR." }));
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            enabled: true,
            bundleHash: "stub-hash",
            manifestPath: "/home/user/.mullion/sync-manifest.json",
            clis: [],
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Direct commits, or always branch + PR?");
    await user.click(screen.getByText("Always branch + PR"));
    await user.click(screen.getByText("Preview"));

    expect(await screen.findByText("boom")).toBeInTheDocument();
    // The question flow is NOT silently re-shown in place of any feedback.
    expect(screen.queryByText("Direct commits, or always branch + PR?")).not.toBeInTheDocument();

    await user.click(screen.getByText("Retry"));

    expect(
      await screen.findByText(/This replaces your current workflow conventions text/),
    ).toBeInTheDocument();
  });
});

// Issue #1203 (Phase 2) — before this, WorkflowConventionsWizardModal was a
// pure one-shot: no answer state persisted, so reopening it after a first
// run always re-walked the whole question flow from scratch, silently
// discarding hand-edits made to the text since. These tests cover the
// pre-fill/review-step/hand-edit-warning behavior added to fix that.
describe("Settings -> Sessions -> workflow-conventions wizard (pre-fill and review, issue #1203)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  const QUESTIONS = [
    {
      id: "branching",
      question: "Direct commits, or always branch + PR?",
      options: [
        { id: "branch-pr", label: "Always branch + PR", fragment: "Always branch and open a PR." },
        {
          id: "direct-commit",
          label: "Direct commits are fine",
          fragment: "Direct commits are fine.",
        },
      ],
    },
    {
      id: "worktrees",
      question: "Dedicated worktree per branch, or the main checkout?",
      options: [
        {
          id: "worktree",
          label: "Dedicated worktree per branch",
          fragment: "Work in a dedicated worktree per branch.",
        },
        {
          id: "main-checkout",
          label: "Main checkout",
          fragment: "Work directly in the main checkout.",
        },
      ],
    },
  ];

  function stubFetch(opts: { previewText?: string; settingsOverride?: typeof DEFAULT_SETTINGS }) {
    fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url === "/api/settings" && method === "PATCH") {
        return Promise.resolve(jsonResponse(200, opts.settingsOverride ?? DEFAULT_SETTINGS));
      }
      if (url === "/api/workflow-conventions/questions" && method === "GET") {
        return Promise.resolve(jsonResponse(200, { questions: QUESTIONS }));
      }
      if (url === "/api/workflow-conventions/preview" && method === "POST") {
        return Promise.resolve(
          jsonResponse(200, {
            text:
              opts.previewText ??
              "Always branch and open a PR.\n\nWork in a dedicated worktree per branch.",
          }),
        );
      }
      if (url === "/api/bundle-sync/status" && method === "GET") {
        return Promise.resolve(
          jsonResponse(200, {
            enabled: true,
            bundleHash: "stub-hash",
            manifestPath: "/home/user/.mullion/sync-manifest.json",
            clis: [],
          }),
        );
      }
      return Promise.reject(new Error(`unhandled fetch in test: ${method} ${url}`));
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens on the question flow, not the review step, when the wizard has never been run (every answer is the default '')", async () => {
    stubFetch({});
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));

    expect(await screen.findByText("Direct commits, or always branch + PR?")).toBeInTheDocument();
    expect(
      screen.queryByText("Your last answers. Click one to change it, or regenerate as-is."),
    ).not.toBeInTheDocument();
  });

  // Hermes review, PR #1204 — removing the pre-#1201 `disabled={stepIndex
  // === 0}` guard left Back enabled (but a no-op) on the FIRST question of
  // the never-run flow, which has no review step to fall back to. Must stay
  // disabled there specifically — the review-entered flow's own Back-to-
  // review behavior (tested separately below) must keep working.
  it("disables Back on the first question when the wizard has never been run — there is no review step to fall back to", async () => {
    stubFetch({});
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Direct commits, or always branch + PR?");

    expect(screen.getByText("Back")).toBeDisabled();
  });

  it("opens on the review step, pre-filled, when the wizard has been run before", async () => {
    const settingsWithAnswers = {
      ...DEFAULT_SETTINGS,
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        workflowConventionsText:
          "Always branch and open a PR.\n\nWork in a dedicated worktree per branch.",
        workflowConventionAnswers: { branching: "branch-pr", worktrees: "worktree" },
      },
    };
    stubFetch({});
    useDashboardStore.setState({ settings: settingsWithAnswers, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));

    // Review step, not the question flow.
    expect(
      await screen.findByText("Your last answers. Click one to change it, or regenerate as-is."),
    ).toBeInTheDocument();
    expect(screen.getByText("Always branch + PR")).toBeInTheDocument();
    expect(screen.getByText("Dedicated worktree per branch")).toBeInTheDocument();
    // No hand-edit warning — the stored text matches what these exact
    // answers would produce.
    expect(screen.queryByText(/edited by hand/)).not.toBeInTheDocument();
  });

  it("clicking a review row jumps straight to that question, with the prior answer still selected", async () => {
    const settingsWithAnswers = {
      ...DEFAULT_SETTINGS,
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        workflowConventionsText:
          "Always branch and open a PR.\n\nWork in a dedicated worktree per branch.",
        workflowConventionAnswers: { branching: "branch-pr", worktrees: "worktree" },
      },
    };
    stubFetch({});
    useDashboardStore.setState({ settings: settingsWithAnswers, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Your last answers. Click one to change it, or regenerate as-is.");

    // The review row's own answer LABEL, not the question text — clicking
    // it jumps into the question flow at that exact question.
    await user.click(screen.getByText("Dedicated worktree per branch"));

    expect(
      await screen.findByText("Dedicated worktree per branch, or the main checkout?"),
    ).toBeInTheDocument();
    // The prior answer is still selected — Next/Preview isn't disabled.
    expect(screen.getByText("Preview")).not.toBeDisabled();
  });

  it("regenerating from the review step (no changes) reaches the same preview/apply flow", async () => {
    const settingsWithAnswers = {
      ...DEFAULT_SETTINGS,
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        workflowConventionsText: "stale text nobody wrote through the wizard",
        workflowConventionAnswers: { branching: "branch-pr" },
      },
    };
    stubFetch({ previewText: "Always branch and open a PR." });
    useDashboardStore.setState({ settings: settingsWithAnswers, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Your last answers. Click one to change it, or regenerate as-is.");

    await user.click(screen.getByText("Regenerate"));

    expect(
      await screen.findByText(/This replaces your current workflow conventions text/),
    ).toBeInTheDocument();

    await user.click(screen.getByText("Replace current text"));

    await waitFor(() =>
      expect(useDashboardStore.getState().settings.sessions.workflowConventionsText).toBe(
        "Always branch and open a PR.",
      ),
    );
    // The answers behind the applied text are persisted in the same PATCH.
    expect(useDashboardStore.getState().settings.sessions.workflowConventionAnswers).toEqual({
      branching: "branch-pr",
    });
  });

  it("shows the hand-edit warning when the stored text no longer matches what the stored answers would produce", async () => {
    const settingsWithHandEdit = {
      ...DEFAULT_SETTINGS,
      sessions: {
        ...DEFAULT_SETTINGS.sessions,
        workflowConventionsText: "I edited this by hand after the wizard ran.",
        workflowConventionAnswers: { branching: "branch-pr" },
      },
    };
    // The wizard's own preview endpoint returns what `branching: branch-pr`
    // ACTUALLY produces — deliberately different from the hand-edited text
    // above, which is the whole point of this test.
    stubFetch({ previewText: "Always branch and open a PR." });
    useDashboardStore.setState({ settings: settingsWithHandEdit, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));

    expect(await screen.findByText(/edited by hand since the wizard last ran/)).toBeInTheDocument();
  });

  it("does not warn when every stored answer is still the default '' (never run), even though the check runs the same code path", async () => {
    stubFetch({});
    useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });

    const user = userEvent.setup();
    render(<Settings onClose={vi.fn()} initialSection="sessions" />);

    await user.click(await screen.findByText("Generate with wizard"));
    await screen.findByText("Direct commits, or always branch + PR?");

    expect(screen.queryByText(/edited by hand/)).not.toBeInTheDocument();
  });
});

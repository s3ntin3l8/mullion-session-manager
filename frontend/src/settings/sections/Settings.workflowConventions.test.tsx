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
});

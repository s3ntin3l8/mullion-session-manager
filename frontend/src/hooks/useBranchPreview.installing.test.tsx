// @vitest-environment jsdom
// #3588 — a branch preview start that waits for the project's setup recipe on
// the server is marked installing (the button reads "Installing dependencies…")
// until the start returns; a failed recipe's reason reaches the toast.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useBranchPreview } from "./useBranchPreview.js";
import { NoSetupRecipeHint } from "../NoSetupRecipeHint.js";
import { useDashboardStore } from "../store/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";
import type { Session } from "../api/index.js";

describe("useBranchPreview: installing (#3588)", () => {
  let finishCreate!: (status: number, body: unknown) => void;
  let setups: unknown[];

  beforeEach(() => {
    setups = [];
    const { fetchMock } = mockFetch({
      "GET /api/projects/:id/dock/setups": () => jsonResponse(200, setups),
      "POST /api/previews": () =>
        new Promise<Response>((resolve) => {
          finishCreate = (status, body) => resolve(jsonResponse(status, body));
        }),
      "GET /api/server-info": () => jsonResponse(200, { previewsEnabled: true }),
      "GET /api/previews": () => jsonResponse(200, []),
    });
    vi.stubGlobal("fetch", fetchMock);
    resetStore({ projects: [makeProject({ id: 1 })], sessions: [] });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("marks the start installing while the server runs the recipe", async () => {
    setups = [
      { projectId: 1, hostId: "local", dockControlId: null, branch: "feat/x", startedAt: 1 },
    ];
    const { result } = renderHook(() => useBranchPreview(1));
    let opened!: Promise<void>;
    act(() => {
      opened = result.current.open({ kind: "branch", branch: "feat/x" }, undefined);
    });
    expect(result.current.starting.has("branch:feat/x")).toBe(true);
    await waitFor(() => expect(result.current.installing.has("branch:feat/x")).toBe(true), {
      timeout: 4000,
    });
    await act(async () => {
      finishCreate(201, { slug: "s", kind: "project", projectId: 1, branch: "feat/x" });
      await opened;
    });
    expect(result.current.installing.size).toBe(0);
    expect(result.current.starting.size).toBe(0);
  });

  it("reports a failed recipe's reason", async () => {
    const { result } = renderHook(() => useBranchPreview(1));
    let opened!: Promise<void>;
    act(() => {
      opened = result.current.open({ kind: "branch", branch: "feat/x" }, undefined);
    });
    await act(async () => {
      finishCreate(424, {
        statusCode: 424,
        code: "setup_failed",
        message: "Installing dependencies failed (exit code 1); the command was not run.",
      });
      await opened;
    });
    const toasts = useDashboardStore.getState().toasts.map((t) => t.message);
    expect(toasts.join("\n")).toContain("Installing dependencies failed (exit code 1)");
  });
});

describe("NoSetupRecipeHint (#3588)", () => {
  const hinted = (projectId: number) =>
    makeSession({ id: 5, projectId, setupHint: "no-recipe" } as Partial<Session>);

  it("shows while the project has no recipe and a session was hinted", () => {
    resetStore({ projects: [makeProject({ id: 1 })], sessions: [hinted(1)] });
    render(<NoSetupRecipeHint projectId={1} />);
    expect(screen.getByRole("note")).toHaveTextContent("This project has no setup recipe");
  });

  it("is hidden once a recipe is set, or with nothing hinted", () => {
    resetStore({
      projects: [makeProject({ id: 1, setupRecipe: "npm ci" }), makeProject({ id: 2 })],
      sessions: [hinted(1)],
    });
    const { container } = render(
      <>
        <NoSetupRecipeHint projectId={1} />
        <NoSetupRecipeHint projectId={2} />
      </>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

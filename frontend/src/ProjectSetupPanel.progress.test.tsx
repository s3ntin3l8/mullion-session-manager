// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSetupPanel } from "./ProjectSetupPanel.js";
import { __resetRateLimitBreakerForTests } from "./api/client.js";
import type { ScaffoldGenerateJob } from "./api/projects.js";
import { jsonResponse } from "./test/jsonResponse.js";
import { useDashboardStore } from "./store/index.js";

// What a generation turn produced — the same body the synchronous
// /setup/generate used to return.
const generatedResult = (extra: Record<string, unknown> = {}) => ({
  previewId: "gen1",
  diff: "diff --git a/AGENTS.md b/AGENTS.md\n+generated line\n",
  files: ["AGENTS.md", ".claude/skills/demo/SKILL.md"],
  hasAgentsOverride: false,
  sandboxed: true,
  ...extra,
});

// A generation JOB (issue #2429): the panel starts one, polls it, and picks
// it back up when the panel opens again.
const finishedJob = (extra: Record<string, unknown> = {}) => ({
  jobId: "job1",
  slug: "demo",
  phase: "done",
  agent: "claude",
  mode: "keep",
  startedAt: Date.now(),
  finishedAt: Date.now(),
  result: generatedResult(),
  ...extra,
});

function mockFetch(opts: {
  preview?: (body: unknown) => Response | Promise<Response>;
  apply?: (body: unknown) => Response | Promise<Response>;
  // POST /setup/generate/start — 202 { jobId }; the agent turn then runs in
  // the background and the panel polls GET /setup/generate/jobs/:jobId.
  startGenerate?: (body: unknown) => Response | Promise<Response>;
  // GET /setup/generate/jobs/:jobId — the job's current state.
  job?: (jobId: string) => Response | Promise<Response>;
  // GET /setup/generate/active — the project's current job (204 = none).
  activeGenerate?: () => Response | Promise<Response>;
  // Hermes review, PR #1200 round 3 (suggestion) — the panel now fetches
  // this on mount to drive its "(see the exact defaults)" disclosure;
  // defaults to a fixed literal here so every EXISTING test (which never
  // asserted on this text) keeps working unchanged.
  scaffoldDefaultsText?: string;
  // GET /setup/preview/active (#2478); absent = the server holds nothing (204).
  active?: () => Response | Promise<Response>;
}) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.endsWith("/setup/preview/active")) {
      return Promise.resolve(opts.active ? opts.active() : new Response(null, { status: 204 }));
    }
    if (url.endsWith("/setup/generate/start") && init?.method === "POST") {
      return Promise.resolve(
        opts.startGenerate ? opts.startGenerate(body) : jsonResponse(202, { jobId: "job1" }),
      );
    }
    if (/\/setup\/generate\/jobs\/[^/]+$/.test(url)) {
      const jobId = url.slice(url.lastIndexOf("/") + 1);
      return Promise.resolve(opts.job ? opts.job(jobId) : jsonResponse(200, finishedJob()));
    }
    if (url.endsWith("/setup/generate/active")) {
      return Promise.resolve(
        opts.activeGenerate ? opts.activeGenerate() : new Response(null, { status: 204 }),
      );
    }
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
  beforeEach(() => {
    useDashboardStore.setState({ scaffoldDrafts: {} });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    __resetRateLimitBreakerForTests();
  });

  // Issue #2429 — the panel shows what the background job is doing, and
  // picks a run back up when it opens again.
  describe("generation job progress", () => {
    // A job that has been running for a minute and five.
    const runningJob = (startedAt: number): ScaffoldGenerateJob => ({
      jobId: "job9",
      slug: "demo",
      phase: "agent",
      agent: "codex",
      mode: "restructure",
      startedAt,
    });
    const doneJob = (startedAt: number): ScaffoldGenerateJob => ({
      ...runningJob(startedAt),
      phase: "done",
      finishedAt: startedAt + 65_000,
      result: {
        previewId: "gen1",
        diff: "diff --git a/AGENTS.md b/AGENTS.md\n+generated line\n",
        files: ["AGENTS.md", ".claude/skills/demo/SKILL.md"],
        hasAgentsOverride: false,
        sandboxed: true,
      },
    });

    it("shows the agent, the mode, the phase and the elapsed time while the job runs", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal("fetch", mockFetch({ job: () => jsonResponse(200, runningJob(startedAt)) }));
      const user = userEvent.setup();
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);
      await user.type(screen.getByPlaceholderText("my-project"), "demo");
      await user.click(screen.getByRole("button", { name: /^Generate with / }));

      await waitFor(() =>
        expect(screen.getByTestId("generate-progress")).toHaveTextContent("codex"),
      );
      expect(screen.getByTestId("generate-progress")).toHaveTextContent(
        "restructuring existing instructions",
      );
      // The slug the run is for — the form may already have moved on.
      expect(screen.getByTestId("generate-progress")).toHaveTextContent("demo");
      expect(screen.getByTestId("generate-progress-phase")).toHaveTextContent("Running the agent…");
      // Measured from the server's startedAt, not from when this panel saw
      // the job — a reopened panel shows the real elapsed time.
      expect(screen.getByTestId("generate-progress-elapsed")).toHaveTextContent("Elapsed 1:05");
      expect(screen.getByText("Safe to close this panel; it keeps running.")).toBeInTheDocument();
      // The form is locked while the turn runs.
      expect(screen.getByRole("button", { name: "Generating…" })).toBeDisabled();
    });

    it("keeps counting the elapsed time while the job runs", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        vi.stubGlobal(
          "fetch",
          mockFetch({
            activeGenerate: () => jsonResponse(200, runningJob(startedAt)),
            job: () => jsonResponse(200, runningJob(startedAt)),
          }),
        );
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(screen.getByTestId("generate-progress-elapsed")).toHaveTextContent("Elapsed 1:05");
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByTestId("generate-progress-elapsed")).toHaveTextContent("Elapsed 1:07");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops polling once the job is done", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        const jobMock = vi.fn(() => jsonResponse(200, runningJob(startedAt)));
        vi.stubGlobal("fetch", mockFetch({ job: jobMock }));
        // The job is already running for this project — the panel picks it
        // up and polls it.
        useDashboardStore.getState().patchScaffoldDraft(1, {
          slug: "demo",
          generateJob: runningJob(startedAt),
        });
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(jobMock).toHaveBeenCalledTimes(1);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(jobMock).toHaveBeenCalledTimes(2);

        // The job finishes: its result becomes the preview and the poll
        // stops.
        jobMock.mockReturnValue(jsonResponse(200, doneJob(startedAt)));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(jobMock).toHaveBeenCalledTimes(3);
        expect(screen.getByText("Preview — 2 files")).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(jobMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops polling when the job fails", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        const jobMock = vi.fn(() => jsonResponse(200, runningJob(startedAt)));
        vi.stubGlobal("fetch", mockFetch({ job: jobMock }));
        useDashboardStore.getState().patchScaffoldDraft(1, {
          slug: "demo",
          generateJob: runningJob(startedAt),
        });
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(jobMock).toHaveBeenCalledTimes(1);

        jobMock.mockReturnValue(
          jsonResponse(200, {
            ...runningJob(startedAt),
            phase: "failed",
            finishedAt: startedAt + 65_000,
            error: { status: 502, message: "the agent turn failed" },
          }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByText(/the agent turn failed/)).toBeInTheDocument();
        expect(screen.queryByTestId("generate-progress")).not.toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(jobMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops polling a job that finished without a result", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        const jobMock = vi.fn(() => jsonResponse(200, runningJob(startedAt)));
        vi.stubGlobal("fetch", mockFetch({ job: jobMock }));
        useDashboardStore.getState().patchScaffoldDraft(1, {
          slug: "demo",
          generateJob: runningJob(startedAt),
        });
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        jobMock.mockReturnValue(
          jsonResponse(200, {
            ...runningJob(startedAt),
            phase: "done",
            finishedAt: startedAt + 65_000,
          }),
        );
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2000);
        });
        expect(screen.getByText(/finished without a result/)).toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(jobMock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("reattaches to a running job when the panel opens again", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          activeGenerate: () => jsonResponse(200, runningJob(startedAt)),
          job: () => jsonResponse(200, runningJob(startedAt)),
        }),
      );
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      await waitFor(() =>
        expect(screen.getByTestId("generate-progress")).toHaveTextContent("codex"),
      );
      expect(screen.getByTestId("generate-progress-elapsed")).toHaveTextContent("Elapsed 1:05");
      expect(screen.getByText("Safe to close this panel; it keeps running.")).toBeInTheDocument();
    });

    it("reattaches to a finished job and shows its preview", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({ activeGenerate: () => jsonResponse(200, doneJob(startedAt)) }),
      );
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
      expect(screen.queryByTestId("generate-progress")).not.toBeInTheDocument();
    });

    it("shows the error of a failed job when the panel opens again", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          activeGenerate: () =>
            jsonResponse(200, {
              ...runningJob(startedAt),
              phase: "failed",
              finishedAt: startedAt + 65_000,
              error: { status: 502, message: "the agent turn failed" },
            }),
        }),
      );
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(await screen.findByText(/the agent turn failed/)).toBeInTheDocument();
      expect(screen.queryByTestId("generate-progress")).not.toBeInTheDocument();
    });

    it("does not resurrect a finished job over a preview the user dismissed", async () => {
      const startedAt = Date.now() - 65_000;
      const activeGenerate = vi.fn(() => jsonResponse(200, doneJob(startedAt)));
      vi.stubGlobal("fetch", mockFetch({ activeGenerate }));
      // The panel watched this job finish and the user backed out of the
      // preview: the store already knows the job, so the server's copy of
      // it must not bring the dismissed preview back.
      useDashboardStore.getState().patchScaffoldDraft(1, {
        slug: "demo",
        preview: null,
        generateJob: doneJob(startedAt),
      });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      await waitFor(() => expect(activeGenerate).toHaveBeenCalled());
      expect(screen.queryByText("Preview — 2 files")).not.toBeInTheDocument();
      expect(screen.getByPlaceholderText("my-project")).toHaveValue("demo");
    });

    it("adopts a finished job the panel has never seen, even when the form was used", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({ activeGenerate: () => jsonResponse(200, doneJob(startedAt)) }),
      );
      // The user touched the form (so a draft exists) but the job was
      // started elsewhere: its result must not be lost.
      useDashboardStore.getState().patchScaffoldDraft(1, { slug: "demo" });
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(await screen.findByText("Preview — 2 files")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
    });

    it("shows the refresh checkboxes when the job reports the files already exist", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          activeGenerate: () =>
            jsonResponse(200, {
              ...runningJob(startedAt),
              phase: "failed",
              finishedAt: startedAt + 65_000,
              error: { status: 409, message: "skill and reviewer already exist" },
            }),
        }),
      );
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(await screen.findByLabelText("Regenerate the skill")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /^Generate with / })).toBeDisabled();
    });

    it("explains a rate limit the job reports, instead of showing the raw error", async () => {
      const startedAt = Date.now() - 65_000;
      vi.stubGlobal(
        "fetch",
        mockFetch({
          activeGenerate: () =>
            jsonResponse(200, {
              ...runningJob(startedAt),
              phase: "failed",
              finishedAt: startedAt + 65_000,
              error: { status: 429, message: "Rate limit exceeded" },
            }),
        }),
      );
      render(<ProjectSetupPanel params={{ projectId: 1 }} />);

      expect(
        await screen.findByText(/rate limited — try again in about 1 minute/),
      ).toBeInTheDocument();
    });

    it("stops tracking a job the server no longer knows, with a message", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        const jobMock = vi.fn(() => jsonResponse(404, { message: "not found" }));
        vi.stubGlobal("fetch", mockFetch({ job: jobMock }));
        useDashboardStore.getState().patchScaffoldDraft(1, {
          slug: "demo",
          generateJob: runningJob(startedAt),
        });
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(screen.getByText(/generation job is gone/)).toBeInTheDocument();
        expect(screen.queryByTestId("generate-progress")).not.toBeInTheDocument();
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(jobMock).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops polling when the slug no longer matches the running job", async () => {
      vi.useFakeTimers();
      try {
        const startedAt = Date.now() - 65_000;
        const jobMock = vi.fn(() => jsonResponse(200, runningJob(startedAt)));
        vi.stubGlobal("fetch", mockFetch({ job: jobMock }));
        useDashboardStore.getState().patchScaffoldDraft(1, {
          slug: "demo",
          generateJob: runningJob(startedAt),
        });
        render(<ProjectSetupPanel params={{ projectId: 1 }} />);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(0);
        });
        expect(jobMock).toHaveBeenCalledTimes(1);

        // The slug is edited: the form no longer describes the running job,
        // so the panel stops following it. The run itself keeps going on
        // the server, and the panel keeps saying so.
        fireEvent.change(screen.getByPlaceholderText("my-project"), {
          target: { value: "other" },
        });
        await act(async () => {
          await vi.advanceTimersByTimeAsync(10_000);
        });
        expect(jobMock).toHaveBeenCalledTimes(1);
        expect(screen.getByTestId("generate-progress")).toHaveTextContent("demo");
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  api,
  ApiError,
  type DockerStorageStatus,
  type SystemStats,
  type DevWorktreeStatus,
  type OpencodeStorageStatus,
  type TempStorageStatus,
  type CacheStorageStatus,
  type CleanupJob,
  type CleanupStepState,
} from "../../api/index.js";
import { StorageSection } from "./StorageSection.js";
import { useDashboardStore } from "../../store/index.js";
import { DEFAULT_SETTINGS } from "../../api/settings.js";

const GIB = 1024 ** 3;
const stats: SystemStats = {
  sampledAt: "2026-09-13T12:00:00.000Z",
  cpu: { logicalCores: 8, loadAverage1m: 2.5 },
  memory: { totalBytes: 64 * GIB, freeBytes: 16 * GIB },
  filesystems: [
    {
      labels: ["Home", "Working directory"],
      paths: ["/home", "/work"],
      available: true,
      totalBytes: 100 * GIB,
      freeBytes: 12 * GIB,
      freePercent: 12,
      severity: "warning",
    },
  ],
};

const docker: DockerStorageStatus = {
  available: true,
  rows: [],
  totalSizeBytes: 10 * GIB,
  reclaimableBytes: 4 * GIB,
  estimates: { safeBytes: 2 * GIB, aggressiveBytes: 3 * GIB },
};

const tempUnavailable: TempStorageStatus = {
  available: false,
  root: "/tmp",
  estimates: { safeBytes: 0, aggressiveBytes: 0, npmCacheBytes: 0 },
  candidates: { safe: 0, aggressive: 0 },
  claudeScratch: { warnings: [] },
};

const noOpencode: OpencodeStorageStatus = {
  available: false,
  path: "/home/me/.local/share/opencode/opencode.db",
  fileBytes: 0,
  reclaimableBytes: 0,
  liveBytes: 0,
  inUse: false,
  holdersUnknown: false,
  compacting: false,
};

const noWorktrees: DevWorktreeStatus = { available: true, candidates: [], totalBytes: 0 };

const noCaches: CacheStorageStatus = { available: true, root: "/home/me/.cache", caches: [] };

const ready = <T extends object>(value: T) => ({
  ...value,
  state: "ready" as const,
  measuredAt: new Date().toISOString(),
});

const stepOf = (
  source: CleanupStepState["source"],
  over: Partial<CleanupStepState> = {},
): CleanupStepState => ({
  source,
  label: {
    docker: "Docker",
    temp: "Temp files",
    caches: "Caches",
    opencode: "opencode database",
    worktrees: "Developer worktrees",
  }[source],
  state: "done",
  reclaimedBytes: 0,
  ...over,
});

const jobOf = (over: Partial<CleanupJob> = {}): CleanupJob => ({
  id: "job-1",
  mode: "safe",
  state: "done",
  startedAt: new Date().toISOString(),
  finishedAt: new Date().toISOString(),
  steps: [stepOf("docker"), stepOf("temp")],
  ...over,
});

/** The server finishes a job instantly: starting it returns it already done. */
function mockCleanup(job: CleanupJob) {
  return vi.spyOn(api, "startCleanup").mockResolvedValue(job);
}

async function confirm(name: string) {
  const button = await screen.findByRole("button", { name });
  await userEvent.click(button);
  await userEvent.click(button);
}

function setup(
  overrides: {
    docker?: DockerStorageStatus;
    temp?: TempStorageStatus;
    caches?: CacheStorageStatus;
    opencode?: OpencodeStorageStatus;
    worktrees?: DevWorktreeStatus;
  } = {},
) {
  useDashboardStore.setState({ settings: DEFAULT_SETTINGS, settingsLoaded: true });
  vi.spyOn(api, "getCacheStorage").mockResolvedValue(ready(overrides.caches ?? noCaches));
  vi.spyOn(api, "getOpencodeStorage").mockResolvedValue(ready(overrides.opencode ?? noOpencode));
  vi.spyOn(api, "getDevWorktrees").mockResolvedValue(ready(overrides.worktrees ?? noWorktrees));
  vi.spyOn(api, "getCleanupStatus").mockResolvedValue({ state: "idle" });
  vi.spyOn(api, "getSystemStats").mockResolvedValue(stats);
  vi.spyOn(api, "getDockerStorage").mockResolvedValue(ready(overrides.docker ?? docker));
  vi.spyOn(api, "getTempStorage").mockResolvedValue(ready(overrides.temp ?? tempUnavailable));
}

describe("Settings -> Storage", () => {
  afterEach(() => vi.restoreAllMocks());

  it("shows each filesystem with a usage meter, and each tier's estimate per source", async () => {
    setup();
    render(<StorageSection />);
    expect(await screen.findByText("Home, Working directory")).toBeInTheDocument();
    expect(screen.getByText("12 GiB free of 100 GiB (12.0%)")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "88% used" })).toBeInTheDocument();
    const safe = (await screen.findByText("Safe")).closest(".storage-tier") as HTMLElement;
    const aggressive = screen.getByText("Aggressive").closest(".storage-tier") as HTMLElement;
    expect(within(safe).getByText("Docker").nextElementSibling).toHaveTextContent("2.0 GiB");
    expect(within(aggressive).getByText("Docker").nextElementSibling).toHaveTextContent("3.0 GiB");
    expect(within(safe).getByText(/^≈ 2.0 GiB/)).toBeInTheDocument();
  });

  describe("measuring in the background", () => {
    const measuringOnly = { state: "measuring" as const, measuredAt: null };
    const tempReady: TempStorageStatus = {
      available: true,
      root: "/tmp",
      estimates: { safeBytes: GIB, aggressiveBytes: 4 * GIB, npmCacheBytes: GIB },
      candidates: { safe: 3, aggressive: 9 },
      claudeScratch: { warnings: [] },
    };

    it("shows disks and Docker while temp files are still being measured", async () => {
      setup();
      vi.spyOn(api, "getTempStorage").mockResolvedValue(measuringOnly);
      render(<StorageSection />);
      expect(await screen.findByText("Home, Working directory")).toBeInTheDocument();
      const safe = screen.getByText("Safe").closest(".storage-tier") as HTMLElement;
      expect(await within(safe).findByText("2.0 GiB")).toBeInTheDocument();
      expect(within(safe).getByText("Temp files").nextElementSibling).toHaveTextContent(
        "measuring…",
      );
      // A total with something still missing is marked as a floor.
      expect(within(safe).getByText(/^≈ 2.0 GiB\+$/)).toBeInTheDocument();
      // The server decides what runs, so cleanup doesn't wait for the figures.
      expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled();
      expect(screen.getByRole("button", { name: "Measuring…" })).toBeDisabled();
    });

    it("polls a measuring probe until it settles, then stops", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setup();
        const temp = vi
          .spyOn(api, "getTempStorage")
          .mockResolvedValueOnce(measuringOnly)
          .mockResolvedValue(ready(tempReady));
        render(<StorageSection />);
        await screen.findByText("Home, Working directory");
        expect(temp).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2100);
        const aggressive = screen.getByText("Aggressive").closest(".storage-tier") as HTMLElement;
        await waitFor(() =>
          expect(within(aggressive).getByText("npm cache").nextElementSibling).toHaveTextContent(
            "1.0 GiB",
          ),
        );
        expect(within(aggressive).getByText("Temp files").nextElementSibling).toHaveTextContent(
          "3.0 GiB",
        );
        const calls = temp.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(temp).toHaveBeenCalledTimes(calls);
        await waitFor(() =>
          expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).toBeEnabled(),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("asks for new measurements on Refresh and shows it working", async () => {
      setup();
      let finish!: (value: ReturnType<typeof ready<DockerStorageStatus>>) => void;
      render(<StorageSection />);
      const button = await screen.findByRole("button", { name: "Refresh" });
      await waitFor(() => expect(button).toBeEnabled());
      vi.mocked(api.getDockerStorage).mockImplementation(
        (refresh) =>
          new Promise((resolve) => {
            if (refresh) finish = resolve;
            else resolve(ready(docker));
          }),
      );
      await userEvent.click(button);
      expect(api.getDockerStorage).toHaveBeenLastCalledWith(true);
      expect(api.getTempStorage).toHaveBeenLastCalledWith(true);
      expect(api.getSystemStats).toHaveBeenLastCalledWith(true);
      expect(screen.getByRole("button", { name: "Measuring…" })).toBeDisabled();
      finish(ready(docker));
      await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    });

    it("shows a filesystem that can't be measured as unavailable, not as a low-disk alert", async () => {
      setup();
      vi.spyOn(api, "getSystemStats").mockResolvedValue({
        ...stats,
        filesystems: [
          { labels: ["Gone"], paths: ["/mnt/gone"], available: false, error: "ENOENT" },
        ],
      });
      render(<StorageSection />);
      const figure = await screen.findByText("ENOENT");
      expect(figure).toHaveClass("resource-unavailable");
      expect(figure).not.toHaveClass("resource-critical");
      expect(screen.queryByRole("img", { name: /used/ })).not.toBeInTheDocument();
    });

    it("says how long ago the oldest figure was measured", async () => {
      setup();
      const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
      vi.spyOn(api, "getDockerStorage").mockResolvedValue({
        ...docker,
        state: "ready",
        measuredAt: tenMinutesAgo,
      });
      render(<StorageSection />);
      expect(await screen.findByText("Measured 10m ago")).toBeInTheDocument();
    });

    it("keeps old figures on screen, marked as updating, while a re-measure runs", async () => {
      setup();
      vi.spyOn(api, "getDockerStorage").mockResolvedValue({
        ...docker,
        state: "measuring",
        measuredAt: new Date().toISOString(),
      });
      render(<StorageSection />);
      const safe = (await screen.findByText("Safe")).closest(".storage-tier") as HTMLElement;
      expect(await within(safe).findByText("2.0 GiB · updating…")).toBeInTheDocument();
    });

    it("reports a probe that failed, and still allows cleanup of the rest", async () => {
      setup();
      vi.spyOn(api, "getTempStorage").mockResolvedValue({
        state: "error",
        measuredAt: null,
        error: "disk gone",
      });
      render(<StorageSection />);
      const safe = (await screen.findByText("Safe")).closest(".storage-tier") as HTMLElement;
      expect(await within(safe).findByText(/disk gone/)).toBeInTheDocument();
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled(),
      );
    });

    it.each([
      ["temp files", "getTempStorage", { available: false, root: "/tmp", error: "EACCES: /tmp" }],
      ["opencode", "getOpencodeStorage", { available: false, path: "/x", error: "db unreadable" }],
      ["worktrees", "getDevWorktrees", { available: false, candidates: [], error: "git failed" }],
    ] as const)(
      "keeps the %s row and says why when it reports an error",
      async (_label, method, payload) => {
        setup();
        vi.spyOn(api, method).mockResolvedValue({
          ...payload,
          state: "ready",
          measuredAt: new Date().toISOString(),
        } as never);
        render(<StorageSection />);
        const message = payload.error;
        expect((await screen.findAllByText(new RegExp(message))).length).toBeGreaterThan(0);
      },
    );

    it("leaves opencode out when it simply isn't there", async () => {
      setup();
      render(<StorageSection />);
      await screen.findByText("Home, Working directory");
      expect(screen.queryByText("opencode database")).not.toBeInTheDocument();
    });

    it("shows a failed request for a probe instead of measuring forever", async () => {
      setup();
      vi.spyOn(api, "getTempStorage").mockRejectedValue(new Error("network"));
      render(<StorageSection />);
      const safe = (await screen.findByText("Safe")).closest(".storage-tier") as HTMLElement;
      expect(await within(safe).findByText(/Could not load/)).toBeInTheDocument();
    });

    it("shows a failed disk-usage request", async () => {
      setup();
      vi.spyOn(api, "getSystemStats").mockRejectedValue(new Error("network"));
      render(<StorageSection />);
      expect(await screen.findByText("Could not load disk usage")).toBeInTheDocument();
    });

    it("lists the npm cache on its own in the aggressive tier only", async () => {
      setup({ temp: tempReady });
      render(<StorageSection />);
      const aggressive = (await screen.findByText("Aggressive")).closest(
        ".storage-tier",
      ) as HTMLElement;
      const safe = screen.getByText("Safe").closest(".storage-tier") as HTMLElement;
      expect(await within(aggressive).findByText("npm cache")).toBeInTheDocument();
      expect(within(safe).queryByText("npm cache")).not.toBeInTheDocument();
      // 4 GiB aggressive temp total, of which 1 GiB is the npm cache.
      expect(within(aggressive).getByText("Temp files").nextElementSibling).toHaveTextContent(
        "3.0 GiB",
      );
    });
  });

  it("explains why Docker is missing from the tiers when it is unavailable", async () => {
    setup({
      docker: {
        available: false,
        rows: [],
        totalSizeBytes: 0,
        reclaimableBytes: 0,
        estimates: { safeBytes: null, aggressiveBytes: 0 },
        error: "permission denied",
      },
    });
    render(<StorageSection />);
    expect(
      await screen.findByText(/Docker cleanup unavailable: permission denied/),
    ).toBeInTheDocument();
    const safe = screen.getByText("Safe").closest(".storage-tier") as HTMLElement;
    expect(within(safe).queryByText("Docker")).not.toBeInTheDocument();
  });
  it("labels the armed safe button without moving or arming the aggressive one", async () => {
    setup();
    render(<StorageSection />);
    const safe = await screen.findByRole("button", { name: "Clean up (safe)…" });
    await waitFor(() => expect(safe).toBeEnabled());
    await userEvent.click(safe);
    expect(screen.getByRole("button", { name: /Confirm safe cleanup/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).not.toHaveClass("armed");
  });
  it("says when Claude scratch is left alone, and which registry files were skipped", async () => {
    setup({
      temp: {
        available: true,
        root: "/tmp",
        estimates: { safeBytes: 0, aggressiveBytes: 0, npmCacheBytes: 0 },
        candidates: { safe: 0, aggressive: 0 },
        claudeScratch: {
          skipped: "/home/me/.claude/sessions/x.json is unparseable and its process may be running",
          warnings: [
            "/home/me/.claude/sessions/9.json is unparseable; skipped (its process is gone)",
          ],
        },
      },
    });
    render(<StorageSection />);
    expect(await screen.findByText(/is being left alone:/)).toHaveTextContent(
      "x.json is unparseable and its process may be running",
    );
    expect(screen.getByText(/9\.json is unparseable; skipped/)).toBeInTheDocument();
  });

  describe("running a cleanup", () => {
    it("requires two clicks, starts the job once, and shows what it freed", async () => {
      setup();
      mockCleanup(jobOf({ steps: [stepOf("docker", { reclaimedBytes: GIB }), stepOf("temp")] }));
      render(<StorageSection />);
      const first = await screen.findByRole("button", { name: "Clean up (safe)…" });
      await userEvent.click(first);
      expect(api.startCleanup).not.toHaveBeenCalled();
      await userEvent.click(first);
      await waitFor(() => expect(api.startCleanup).toHaveBeenCalledOnce());
      expect(api.startCleanup).toHaveBeenCalledWith("safe", []);
      expect(
        await screen.findByText("Freed 1.0 GiB (Docker 1.0 GiB, temp files 0 B)."),
      ).toBeInTheDocument();
    });

    it("is available before anything has finished measuring: the server decides what runs", async () => {
      setup();
      vi.spyOn(api, "getTempStorage").mockReturnValue(new Promise(() => {}));
      vi.spyOn(api, "getDockerStorage").mockReturnValue(new Promise(() => {}));
      mockCleanup(jobOf());
      render(<StorageSection />);
      const safe = await screen.findByRole("button", { name: "Clean up (safe)…" });
      expect(safe).toBeEnabled();
      expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).toBeEnabled();
    });

    it("runs the aggressive tier with its own mode", async () => {
      setup();
      mockCleanup(
        jobOf({
          mode: "aggressive",
          steps: [stepOf("docker", { reclaimedBytes: 3 * GIB, note: "step failed" })],
        }),
      );
      render(<StorageSection />);
      await confirm("Aggressive cleanup…");
      await waitFor(() => expect(api.startCleanup).toHaveBeenCalledWith("aggressive", []));
      expect(
        await screen.findByText("Freed 3.0 GiB, then stopped: step failed"),
      ).toBeInTheDocument();
    });

    it("sends the ticked caches along, and nothing when none are ticked", async () => {
      setup({
        caches: {
          available: true,
          root: "/home/me/.cache",
          caches: [{ id: "pip", label: "pip", bytes: GIB, exists: true }],
        },
      });
      useDashboardStore.setState({
        settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: ["pip"] } },
      });
      mockCleanup(jobOf({ mode: "aggressive" }));
      render(<StorageSection />);
      await confirm("Aggressive cleanup…");
      await waitFor(() => expect(api.startCleanup).toHaveBeenCalledWith("aggressive", ["pip"]));
    });

    it("lists each source's outcome, with why one was skipped or failed", async () => {
      setup();
      mockCleanup(
        jobOf({
          mode: "aggressive",
          steps: [
            stepOf("docker", { state: "skipped", note: "Docker unavailable: permission denied" }),
            stepOf("temp", { reclaimedBytes: GIB / 2 }),
            stepOf("opencode", { state: "skipped", note: "opencode is running" }),
            stepOf("worktrees", { state: "error", note: "network" }),
          ],
        }),
      );
      render(<StorageSection />);
      await confirm("Aggressive cleanup…");
      const panel = (await screen.findByText(/^Last cleanup \(aggressive/)).closest(
        ".storage-job",
      ) as HTMLElement;
      const row = (label: string) => within(panel).getByText(label).nextElementSibling;
      expect(row("Docker")).toHaveTextContent("skipped: Docker unavailable: permission denied");
      expect(row("Temp files")).toHaveTextContent("freed 512 MiB");
      expect(row("opencode database")).toHaveTextContent("skipped: opencode is running");
      expect(row("Developer worktrees")).toHaveTextContent("failed: network");
      expect(
        within(panel).getByText(
          "Freed 512 MiB (temp files 512 MiB, developer worktrees 0 B), then stopped: network",
        ),
      ).toBeInTheDocument();
    });

    it("says what failed when nothing was freed", async () => {
      setup();
      mockCleanup(jobOf({ steps: [stepOf("docker", { state: "error", note: "failed" })] }));
      render(<StorageSection />);
      await confirm("Clean up (safe)…");
      expect(await screen.findAllByText("failed")).not.toHaveLength(0);
    });

    it("mentions developer worktrees only when they did or reported something", async () => {
      setup();
      mockCleanup(
        jobOf({
          mode: "aggressive",
          steps: [stepOf("docker", { reclaimedBytes: 7 }), stepOf("worktrees")],
        }),
      );
      render(<StorageSection />);
      await confirm("Aggressive cleanup…");
      expect(await screen.findByText("Freed 7 B.")).toBeInTheDocument();
    });

    it("includes developer worktrees in the sentence when they freed space", async () => {
      setup();
      mockCleanup(
        jobOf({
          mode: "aggressive",
          steps: [stepOf("docker"), stepOf("worktrees", { reclaimedBytes: 3 * GIB })],
        }),
      );
      render(<StorageSection />);
      await confirm("Aggressive cleanup…");
      expect(await screen.findByText(/developer worktrees 3.0 GiB/)).toBeInTheDocument();
    });

    it("shows the error when the cleanup can't be started", async () => {
      setup();
      vi.spyOn(api, "startCleanup").mockRejectedValue(new ApiError("Too many requests", 429));
      render(<StorageSection />);
      await confirm("Clean up (safe)…");
      expect(await screen.findByText("Too many requests")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled();
    });

    it("falls back to a generic message for an unexpected start failure", async () => {
      setup();
      vi.spyOn(api, "startCleanup").mockRejectedValue(new Error("network"));
      render(<StorageSection />);
      await confirm("Clean up (safe)…");
      expect(await screen.findByText("Could not start the cleanup.")).toBeInTheDocument();
    });

    it("joins a cleanup another tab already started instead of reporting an error", async () => {
      setup();
      const running = jobOf({
        state: "running",
        finishedAt: undefined,
        steps: [stepOf("docker", { state: "running" })],
      });
      vi.spyOn(api, "startCleanup").mockRejectedValue(
        new ApiError("A cleanup is already running", 409),
      );
      render(<StorageSection />);
      await screen.findByText("Safe");
      vi.mocked(api.getCleanupStatus).mockResolvedValue(running);
      await confirm("Clean up (safe)…");
      expect(await screen.findByText("Cleaning up (safe)…")).toBeInTheDocument();
      expect(screen.queryByText("A cleanup is already running")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).toBeDisabled();
    });
  });

  describe("a cleanup that runs in the background", () => {
    const running = (steps: CleanupStepState[]) =>
      jobOf({ state: "running", finishedAt: undefined, steps });

    it("shows one already running on load, with both buttons disabled", async () => {
      setup();
      vi.mocked(api.getCleanupStatus).mockResolvedValue(
        running([stepOf("docker", { state: "running" }), stepOf("temp", { state: "pending" })]),
      );
      render(<StorageSection />);
      expect(await screen.findByText("Cleaning up (safe)…")).toBeInTheDocument();
      const safe = screen.getByRole("button", { name: "Cleaning up…" });
      expect(safe).toBeDisabled();
      expect(screen.getByRole("button", { name: "Aggressive cleanup…" })).toBeDisabled();
      const panel = screen.getByText("Cleaning up (safe)…").closest(".storage-job") as HTMLElement;
      expect(within(panel).getByText("Docker").nextElementSibling).toHaveTextContent(
        "cleaning up…",
      );
      expect(within(panel).getByText("Temp files").nextElementSibling).toHaveTextContent(
        "waiting…",
      );
    });

    it("shows the last cleanup on load without re-measuring anything", async () => {
      setup();
      vi.mocked(api.getCleanupStatus).mockResolvedValue(
        jobOf({ steps: [stepOf("docker", { reclaimedBytes: GIB })] }),
      );
      render(<StorageSection />);
      expect(await screen.findByText(/^Last cleanup \(safe, just now\)/)).toBeInTheDocument();
      expect(screen.getByText("Freed 1.0 GiB.")).toBeInTheDocument();
      expect(api.getDockerStorage).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled();
    });

    it("follows the job until it is done, then re-measures and stops polling", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setup();
        const status = vi.mocked(api.getCleanupStatus);
        status.mockResolvedValue({ state: "idle" });
        vi.spyOn(api, "startCleanup").mockResolvedValue(
          running([stepOf("docker", { state: "running" }), stepOf("temp", { state: "pending" })]),
        );
        render(<StorageSection />);
        await confirm("Clean up (safe)…");
        expect(await screen.findByText("Cleaning up (safe)…")).toBeInTheDocument();
        expect(api.getDockerStorage).toHaveBeenCalledTimes(1);

        // First poll: Docker is done, temp is running.
        status.mockResolvedValue(
          running([
            stepOf("docker", { reclaimedBytes: GIB }),
            stepOf("temp", { state: "running" }),
          ]),
        );
        await vi.advanceTimersByTimeAsync(2100);
        await waitFor(() =>
          expect(
            screen.getByText("Docker", { selector: ".storage-job span" }).nextElementSibling,
          ).toHaveTextContent("freed 1.0 GiB"),
        );
        expect(api.getDockerStorage).toHaveBeenCalledTimes(1);

        // Second poll: finished. The figures are measured again, once.
        status.mockResolvedValue(
          jobOf({
            steps: [
              stepOf("docker", { reclaimedBytes: GIB }),
              stepOf("temp", { reclaimedBytes: GIB }),
            ],
          }),
        );
        await vi.advanceTimersByTimeAsync(2100);
        expect(
          await screen.findByText("Freed 2.0 GiB (Docker 1.0 GiB, temp files 1.0 GiB)."),
        ).toBeInTheDocument();
        await waitFor(() => expect(api.getDockerStorage).toHaveBeenLastCalledWith(true));
        const polls = status.mock.calls.length;
        await vi.advanceTimersByTimeAsync(10_000);
        expect(status).toHaveBeenCalledTimes(polls);
        expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("says so, and re-measures, when the server forgot the job (it restarted mid-cleanup)", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setup();
        vi.mocked(api.getCleanupStatus).mockResolvedValue(
          running([stepOf("docker", { state: "running" })]),
        );
        render(<StorageSection />);
        expect(await screen.findByText("Cleaning up (safe)…")).toBeInTheDocument();
        vi.mocked(api.getCleanupStatus).mockResolvedValue({ state: "idle" });
        await vi.advanceTimersByTimeAsync(2100);
        expect(await screen.findByText(/The cleanup was interrupted/)).toBeInTheDocument();
        await waitFor(() => expect(api.getDockerStorage).toHaveBeenLastCalledWith(true));
        expect(screen.getByRole("button", { name: "Clean up (safe)…" })).toBeEnabled();
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps what is on screen when a status poll fails", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        setup();
        vi.mocked(api.getCleanupStatus).mockResolvedValue(
          running([stepOf("docker", { state: "running" })]),
        );
        render(<StorageSection />);
        expect(await screen.findByText("Cleaning up (safe)…")).toBeInTheDocument();
        vi.mocked(api.getCleanupStatus).mockRejectedValue(new Error("offline"));
        await vi.advanceTimersByTimeAsync(2100);
        expect(screen.getByText("Cleaning up (safe)…")).toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("stale developer worktrees (#1605)", () => {
    const worktrees: DevWorktreeStatus = {
      available: true,
      totalBytes: 3 * GIB,
      candidates: [
        {
          projectId: 1,
          projectName: "mullion",
          path: "/p/.wt/fix-a",
          slug: "fix-a",
          branch: "fix-a",
          kind: "wt",
          reason: "gone",
          bytes: GIB,
        },
        {
          projectId: 1,
          projectName: "mullion",
          path: "/p/.claude/worktrees/agent-1",
          slug: "agent-1",
          branch: "agent-1",
          kind: "claude-agent",
          reason: "merged",
          detail: "#12",
          bytes: GIB,
        },
        {
          projectId: 2,
          projectName: "other",
          path: "/o/.wt/loose",
          slug: "loose",
          branch: null,
          kind: "wt",
          reason: "detached-merged",
          bytes: GIB,
        },
      ],
    };

    it("lists what would be removed, why, and what it frees", async () => {
      setup({ worktrees });
      render(<StorageSection />);
      const row = (key: string) => screen.getByText(key).nextElementSibling;
      expect(await screen.findByText("mullion / fix-a")).toBeInTheDocument();
      expect(row("mullion / fix-a")).toHaveTextContent(
        "worktree, branch deleted on the remote · 1.0 GiB",
      );
      expect(row("mullion / agent-1")).toHaveTextContent("Claude agent, PR #12 merged");
      expect(row("other / loose")).toHaveTextContent("worktree, already in the default branch");
      expect(screen.getByText(/free 3.0 GiB/)).toBeInTheDocument();
    });

    it("doesn't wait for the worktree preview before showing the rest", async () => {
      setup();
      vi.spyOn(api, "getDevWorktrees").mockReturnValue(new Promise(() => {}));
      render(<StorageSection />);
      expect(await screen.findByText("Disk cleanup")).toBeInTheDocument();
      expect(await screen.findByText("Home, Working directory")).toBeInTheDocument();
      const aggressive = screen.getByRole("button", { name: "Aggressive cleanup…" });
      await waitFor(() => expect(aggressive).toBeEnabled());
    });

    it("shows nothing when there are none, and says so when they can't be listed", async () => {
      setup();
      const { unmount } = render(<StorageSection />);
      await screen.findByText("Disk cleanup");
      expect(screen.queryByText(/Developer worktrees/)).not.toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      setup();
      vi.spyOn(api, "getDevWorktrees").mockRejectedValue(new Error("boom"));
      render(<StorageSection />);
      const row = (await screen.findByText("Developer worktrees")).closest(
        ".storage-tier-row",
      ) as HTMLElement;
      expect(row).toHaveTextContent("Could not load");
      // A failed preview never blocks cleanup: the server decides what is stale.
      const aggressive = screen.getByRole("button", { name: "Aggressive cleanup…" });
      await waitFor(() => expect(aggressive).toBeEnabled());
    });
  });

  describe("opencode database compaction (#1604)", () => {
    const opencode: OpencodeStorageStatus = {
      available: true,
      path: "/home/me/.local/share/opencode/opencode.db",
      fileBytes: 17 * GIB,
      reclaimableBytes: 15 * GIB,
      liveBytes: 2 * GIB,
      inUse: false,
      holdersUnknown: false,
      compacting: false,
    };

    it("shows the file size and what compacting returns, and nothing when opencode is absent", async () => {
      setup({ opencode });
      const { unmount } = render(<StorageSection />);
      const row = (await screen.findByText("opencode database")).closest(
        ".storage-tier-row",
      ) as HTMLElement;
      expect(row).toHaveTextContent("15 GiB");
      expect(screen.getByText(/17 GiB/)).toBeInTheDocument();
      expect(screen.getByText(/skipped whenever opencode is running/)).toBeInTheDocument();
      unmount();
      vi.restoreAllMocks();
      setup();
      render(<StorageSection />);
      await screen.findByText("Disk cleanup");
      expect(screen.queryByText("opencode database")).not.toBeInTheDocument();
    });
  });

  describe("opt-in ~/.cache cleanup (#1606)", () => {
    const caches: CacheStorageStatus = {
      available: true,
      root: "/home/me/.cache",
      caches: [
        { id: "ms-playwright", label: "Playwright browsers", bytes: 2 * GIB, exists: true },
        { id: "pip", label: "pip", bytes: GIB, exists: true },
        { id: "go-build", label: "Go build cache", bytes: 0, exists: false },
      ],
    };

    it("lists existing caches, hides missing ones, and saves the opted-in ids", async () => {
      setup({ caches });
      render(<StorageSection />);
      const toggle = await screen.findByRole("button", {
        name: "Clean Playwright browsers in aggressive cleanup",
      });
      expect(screen.queryByText("Go build cache")).not.toBeInTheDocument();
      await userEvent.click(toggle);
      expect(useDashboardStore.getState().settings.diskCleanup.cacheDirs).toEqual([
        "ms-playwright",
      ]);
    });

    it("keeps an opted-in cache that vanished from disk listed so the stale opt-in can be cleared", async () => {
      setup({ caches });
      useDashboardStore.setState({
        settings: { ...DEFAULT_SETTINGS, diskCleanup: { cacheDirs: ["go-build"] } },
      });
      render(<StorageSection />);
      const toggle = await screen.findByRole("button", {
        name: "Clean Go build cache in aggressive cleanup",
      });
      expect(screen.getByText("not found")).toBeInTheDocument();
      await userEvent.click(toggle);
      expect(useDashboardStore.getState().settings.diskCleanup.cacheDirs).toEqual([]);
    });
  });
});

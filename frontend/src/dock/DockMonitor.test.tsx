// @vitest-environment jsdom
// A single dock monitor's own header — split out of the former monolithic
// Dock.test.tsx (PR 28, Wave 5 of .claude/plans/can-we-do-a-warm-cocke.md),
// owns every test that exercises DockMonitor.tsx's own region: the plain
// start/kill toggle, the worktree/branch selector (including the U5/U8/
// Hermes-round-1 relaunch-race regressions and its own keyboard nav), P10's
// keyboard accessibility, and the Docker Compose kebab/check-update/
// pull-restart surface. Still mounts the full `<Dock>` (same reasoning as
// session-row/Header.test.tsx's own header comment) — DockMonitor's own
// props are computed inside DockColumn's map loop from a lot of column-level
// state, so a full render through a fake in-memory backend is the simplest
// way to exercise the real wiring.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Dock } from "../Dock.js";
import { useDashboardStore } from "../store/index.js";
import { DEFAULT_SETTINGS } from "../api/index.js";
import type { GitBranchesResult, Session } from "../api/index.js";
import { jsonResponse } from "../test/jsonResponse.js";
import { makeProject, makeSession } from "../test/fixtures.js";
import { mockFetch } from "../test/mockFetch.js";
import { resetStore } from "../test/resetStore.js";

// xterm.js's Terminal.open() reaches for browser APIs jsdom doesn't
// implement (e.g. matchMedia on the owner window) — TerminalPane itself is
// covered elsewhere; here we only need to know DockColumn decided to mount
// it (i.e. a monitor is "running"), not exercise the real terminal.
vi.mock("../TerminalPane.js", () => ({
  TerminalPane: ({
    params,
    inputAffordances,
  }: {
    params: { sessionId: number };
    inputAffordances?: boolean;
  }) => (
    <div
      data-testid="terminal-pane"
      data-session-id={params.sessionId}
      data-input-affordances={String(inputAffordances)}
    />
  ),
}));

const PROJECT = makeProject({ id: 1, name: "mullion", cwd: "/home/x/mullion" });

let dockByProject: Record<number, unknown> = {};
let checkUpdateByProject: Record<number, unknown> = {};
let updateByProject: Record<number, unknown> = {};
let rebuildByProject: Record<number, unknown> = {};
let serviceActionResult: { success: boolean } = { success: true };
let stackActionByProject: Record<number, unknown> = {};

describe("Dock", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    dockByProject = {};
    checkUpdateByProject = {};
    updateByProject = {};
    rebuildByProject = {};
    serviceActionResult = { success: true };
    stackActionByProject = {};
    ({ fetchMock } = mockFetch({
      "GET /api/projects/:id/github/prs": () => jsonResponse(204),
      "GET /api/projects/:id/dock": ({ params }) =>
        jsonResponse(200, dockByProject[Number(params.id)] ?? []),
      "GET /api/projects/:id/github": () => jsonResponse(204),
      "POST /api/projects/:id/docker/check-update": ({ params }) =>
        jsonResponse(200, checkUpdateByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/update": ({ params }) =>
        jsonResponse(201, updateByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/rebuild": ({ params }) =>
        jsonResponse(201, rebuildByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/service/restart": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/service/stop": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/service/start": () => jsonResponse(200, serviceActionResult),
      "POST /api/projects/:id/docker/stack/restart": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/apply": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
      "POST /api/projects/:id/docker/stack/stop": ({ params }) =>
        jsonResponse(201, stackActionByProject[Number(params.id)] ?? {}),
    }));
    vi.stubGlobal("fetch", fetchMock);
    // Dock master-detail rework — DockColumn's own `.dock-split--stacked`
    // ResizeObserver (Dock.tsx) doesn't exist in jsdom; same stub PaneTab.
    // test.tsx uses for its own narrow/tight observer. `observe`/
    // `disconnect` only need to not throw — no test here depends on the
    // stacked-layout flip itself, so the callback never needs to fire.
    vi.stubGlobal(
      "ResizeObserver",
      vi.fn(function () {
        return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
      }),
    );
    resetStore({ projects: [PROJECT], sessions: [] });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  describe("monitor toggle", () => {
    it("toggles a configured monitor on/off via createSession/deleteSession", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const user = userEvent.setup();
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession,
        // U8 — this test is about the plain toggle round-trip, not the new
        // arm-then-confirm gate on the kill half of that toggle (see the
        // dedicated "U8" describe block below), so confirmBeforeKill is
        // explicitly off here rather than left at DEFAULT_SETTINGS' own
        // `true`.
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = await screen.findByText("Dev server");
      expect(screen.getByText("off")).toBeInTheDocument();
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: undefined,
        kind: "dock",
      });

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: null,
        env: null,
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [runningSession],
        createSession,
        deleteSession,
      });

      // Dock master-detail rework — stopping a running stream is now the
      // trailing "on"/"off" tag's own job, not the row body's (clicking the
      // row body only SELECTS; see DockMonitor.tsx's own header comment on
      // the select-vs-toggle split, and the dedicated tests below for that
      // split itself).
      await screen.findByText("Dev server");
      const onTag = screen.getByText("on");
      await user.click(onTag);

      expect(deleteSession).toHaveBeenCalledWith(99);
    });

    it("dock master-detail rework — clicking a running row's body SELECTS it without stopping its stream", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const user = userEvent.setup();
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        kind: "dock",
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [runningSession],
        deleteSession,
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const row = await screen.findByText("Dev server");
      await user.click(row);

      expect(deleteSession).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "99");
      });
    });
  });

  describe("issue #1238 — persisted rail-row selection survives reload", () => {
    // Both rows already have a live stream (reload-with-streams-already-
    // running), same setup the adopt-on-empty reconciliation itself is
    // built around (Dock.tsx's own doc comment on `lastRows`). Without a
    // persisted selection, adopt-on-empty would pick "dev" — it's first in
    // `dockByProject[1]` and therefore first in `liveRowKeys`. Persisting
    // "worker" (a non-docker, dock.json-style control, so its row key is
    // `dock-config:worker` per dockRowKey's own doc comment) proves the
    // persisted value is consulted BEFORE that fallback, not just as a
    // tiebreaker for a case adopt-on-empty would already get right.
    function twoRunningControls() {
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        { id: "worker", title: "Worker", command: "npm run worker" },
      ];
      return [
        makeSession({ id: 10, command: "npm run dev", kind: "dock", status: "active" }),
        makeSession({ id: 20, command: "npm run worker", kind: "dock", status: "active" }),
      ];
    }

    it("restores the persisted row and shows its log pane in the same commit adopt-on-empty would have used for the wrong row", async () => {
      const sessions = twoRunningControls();
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:worker" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      // Same "find the terminal pane, assert its session id" technique the
      // existing master-detail tests already use (e.g. "clicking a running
      // row's body SELECTS it" above) as this suite's own proof of no
      // visible flicker to the wrong row — the pane that appears is already
      // showing the persisted session, not a first-render "dev" that a
      // later correction would have to fix up.
      await waitFor(() => {
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "20");
      });
      expect(screen.queryByText("Select a row to view its log")).not.toBeInTheDocument();
    });

    it("falls back to the adopt-on-empty rule when the persisted row no longer matches any control", async () => {
      const sessions = twoRunningControls();
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:ghost" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await waitFor(() => {
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "10");
      });
    });

    it("falls back to no selection when the persisted row is gone and nothing is running", async () => {
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        { id: "worker", title: "Worker", command: "npm run worker" },
      ];
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:ghost" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("Dev server");
      expect(screen.getByText("Select a row to view its log")).toBeInTheDocument();
      expect(screen.queryByTestId("terminal-pane")).not.toBeInTheDocument();
    });

    it("persists a new selection via read-modify-write — preserves this project's own pinned field and another project's entry untouched", async () => {
      const PROJECT2 = makeProject({ id: 2, name: "other", cwd: "/home/x/other" });
      const sessions = twoRunningControls();
      // A third, non-running control (no session — its own row's existence
      // is all this test needs) — issue #1239's own reconciliation now
      // clears a pin that collides with the CURRENT (or, after the
      // reconciliation's own neighbour-search, the ABOUT-TO-BE-current)
      // primary selection, so with only "dev"/"worker" to choose from, any
      // pinned value would necessarily equal one or the other at some point
      // in this test (the initial selection, "dev", or the row clicked
      // below, "worker"). "logs" is real (a genuine row DockColumn will
      // render) but distinct from both, so the read-modify-write this test
      // actually checks — the `pinned` field surviving untouched — isn't
      // confounded by that collision guard.
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        { id: "worker", title: "Worker", command: "npm run worker" },
        { id: "logs", title: "Logs", command: "tail -f log" },
      ];
      dockByProject[2] = [];
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({
          "1": { selected: "dock-config:dev", pinned: "dock-config:logs" },
          "2": { selected: "untouched" },
        }),
      );
      const user = userEvent.setup();
      useDashboardStore.setState({
        projects: [PROJECT, PROJECT2],
        sessions,
        sessionsLoaded: true,
      });

      const { unmount } = render(
        <Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      const workerRow = await screen.findByText("Worker");
      await user.click(workerRow);

      // The write effect's own read-modify-write is what this test exists
      // to prove: project "1"'s entry picks up the new selection while its
      // pre-existing `pinned` field survives untouched (it names a
      // different, still-live row — see the fixture's own comment above),
      // and project "2"'s entry — a second column tiled in the same dock —
      // is never clobbered by project "1"'s write.
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("crs.dockSelectedRows") ?? "{}");
        expect(stored["1"]).toEqual({
          selected: "dock-config:worker",
          pinned: "dock-config:logs",
        });
        expect(stored["2"]).toEqual({ selected: "untouched" });
      });

      // The round trip this whole feature depends on: what the write
      // effect just produced is fed back through the mount-time read on a
      // fresh mount (same project set, same underlying fake backend and
      // store — only `beforeEach` resets those, not this remount) — proving
      // the write and read sides agree on the SAME shape, not just that
      // each independently matches a hand-authored fixture.
      unmount();
      render(<Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      await waitFor(() => {
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "20");
      });
    });

    it("does not clobber a not-yet-consumed persisted seed with null before controls ever load", async () => {
      // Regression coverage for the persist effect's own guard — without
      // it, the very first commit (before the mocked `GET .../dock` fetch
      // resolves, so `controls` is still `[]`) would write `selected: null`
      // straight over the seed below, and a project whose dock config never
      // loads at all (a dead backend, matching this test's own empty
      // `dockByProject[1]`) would never get a later commit to correct it.
      dockByProject[1] = [];
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:dev", pinned: "keep-me" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      // `DockLogPane` renders unconditionally (Dock.tsx's own render, keyed
      // off `selectedSession?.id`), so its empty-hint text is a stable
      // signal that the empty-controls poll has settled, without depending
      // on any control-specific text that (deliberately) never appears here.
      await screen.findByText("Select a row to view its log");
      const stored = JSON.parse(localStorage.getItem("crs.dockSelectedRows") ?? "{}");
      expect(stored["1"]).toEqual({ selected: "dock-config:dev", pinned: "keep-me" });
    });
  });

  describe("issue #1239 — pinned second log pane", () => {
    // Both rows already running — the same twoRunningControls() shape the
    // #1238 suite above uses, duplicated rather than shared across
    // describe blocks (each block's own beforeEach reassigns dockByProject
    // independently, and this file's own convention — see the #1240 suite
    // further down — is a per-suite local helper rather than a single
    // shared one threaded through every describe).
    function twoRunningControls() {
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        { id: "worker", title: "Worker", command: "npm run worker" },
      ];
      return [
        makeSession({ id: 10, command: "npm run dev", kind: "dock", status: "active" }),
        makeSession({ id: 20, command: "npm run worker", kind: "dock", status: "active" }),
      ];
    }

    // Overrides the outer beforeEach's own no-op ResizeObserver stub with
    // one that captures every constructed observer's callback — this
    // suite, unlike every other one in this file, actually needs to FIRE
    // the callback to simulate the column crossing `twoPaneThresholdPx`
    // (Dock.tsx). Runs after the outer beforeEach (nested `beforeEach`s run
    // outer-to-inner), so this simply replaces the earlier stub.
    let resizeCallbacks: Array<(entries: Array<{ contentRect: { width: number } }>) => void>;
    beforeEach(() => {
      resizeCallbacks = [];
      vi.stubGlobal(
        "ResizeObserver",
        vi.fn(function (cb: (entries: Array<{ contentRect: { width: number } }>) => void) {
          resizeCallbacks.push(cb);
          return { observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() };
        }),
      );
    });

    // Fires every captured observer's callback with a synthetic
    // contentRect width — jsdom never actually resizes anything, so this
    // is the hand-driven equivalent of a real layout engine reporting a
    // new column width.
    function resizeTo(width: number) {
      act(() => {
        for (const cb of resizeCallbacks) {
          cb([{ contentRect: { width } }]);
        }
      });
    }

    // Derived from the SAME defaults `stackedThresholdPx`/
    // `twoPaneThresholdPx` (Dock.tsx) are: DEFAULT_RAIL_WIDTH 280 +
    // RAIL_DIVIDER_WIDTH_PX 6 + `dockMonitorMinWidthPx(14, 4)`, pinned at
    // 364 by dockHelpers.test.ts, plus (for two panes only)
    // PANE_DIVIDER_WIDTH_PX 6 — issue #1244's draggable divider between the
    // two panes, which replaced the earlier fixed `.dock-log-pane +
    // .dock-log-pane` CSS margin an earlier version of this threshold
    // omitted entirely (mullion-reviewer). One pane's floor:
    // 280 + 6 + 364 = 650. Two panes' floor: 280 + 6 + 364*2 + 6 = 1020.
    const STACKED_WIDTH = 500; // below 650 — rail flips to stacked mode too
    const ONE_PANE_WIDTH = 800; // between 650 and 1020 — one pane fits
    const TWO_PANE_WIDTH = 1100; // above 1020 — both panes fit

    it("pins a non-selected row as a second log pane, and unpins it on a second click", async () => {
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);

      // Adopt-on-empty picks "dev" (first live row) as the primary
      // selection — its pin affordance is hidden (it's the selected row),
      // leaving "Worker"'s the only "pin" text on screen.
      expect(await screen.findByTestId("terminal-pane")).toHaveAttribute("data-session-id", "10");

      await user.click(screen.getByText("pin"));

      const panes = await screen.findAllByTestId("terminal-pane");
      expect(panes).toHaveLength(2);
      expect(panes[1]).toHaveAttribute("data-session-id", "20");
      expect(screen.getByText("pinned")).toBeInTheDocument();

      await user.click(screen.getByText("pinned"));
      await waitFor(() => {
        expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      });
      expect(screen.getByText("pin")).toBeInTheDocument();
    });

    it("gates the second pane on column width in both directions, without ever clearing pinnedKey itself", async () => {
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);
      await screen.findByTestId("terminal-pane");

      await user.click(screen.getByText("pin"));
      expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);
      expect(document.querySelector(".dock-monitor-pin--pinned")).not.toBeNull();
      expect(document.querySelector(".dock-monitor-pin--hidden")).toBeNull();

      // Narrow past `twoPaneThresholdPx` but still above `stackedThresholdPx`
      // — the second pane disappears, but the pin itself survives: the
      // indicator switches to its dimmed `--hidden` variant instead of
      // reverting to a plain unpinned "pin" tag, proving the pin state
      // (not just the pane) is what this asserts.
      resizeTo(ONE_PANE_WIDTH);
      await waitFor(() => {
        expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      });
      expect(document.querySelector(".dock-monitor-pin--hidden")).not.toBeNull();
      expect(document.querySelector(".dock-monitor-pin--pinned")).toBeNull();
      expect(screen.getByText("pinned")).toBeInTheDocument();

      // Widen back past the threshold — restores with no re-click.
      resizeTo(TWO_PANE_WIDTH);
      await waitFor(() => {
        expect(screen.getAllByTestId("terminal-pane")).toHaveLength(2);
      });
      expect(document.querySelector(".dock-monitor-pin--pinned")).not.toBeNull();
      expect(document.querySelector(".dock-monitor-pin--hidden")).toBeNull();
    });

    it("never shows the second pane in stacked mode, even with room-by-width-alone and an active pin", async () => {
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);
      await screen.findByTestId("terminal-pane");
      await user.click(screen.getByText("pin"));
      expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

      resizeTo(STACKED_WIDTH);
      await waitFor(() => {
        expect(document.querySelector(".dock-split--stacked")).not.toBeNull();
      });
      expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      expect(document.querySelector(".dock-monitor-pin--hidden")).not.toBeNull();
    });

    it("clears pinnedKey (with no reassignment) when the pinned row's own control vanishes", async () => {
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);
      await screen.findByTestId("terminal-pane");
      await user.click(screen.getByText("pin"));
      expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

      // The pinned control ("worker") drops out of the next poll entirely —
      // no orphan session survives it either (unlike issue #1240's own
      // case), so the row itself disappears, not just its stream.
      // `bumpDockConfigRefreshTrigger()` forces the `.../dock` poll to
      // refetch immediately (same technique the PR2b "holding a docker
      // control" suite above uses) rather than waiting out the real
      // DOCKER_POLL_INTERVAL_MS.
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [sessions[0]],
        sessionsLoaded: true,
      });
      useDashboardStore.getState().bumpDockConfigRefreshTrigger();

      await waitFor(() => {
        expect(screen.queryByText("Worker")).not.toBeInTheDocument();
      });
      // No neighbour reassignment — the second pane is simply gone, not
      // reassigned to whatever row happens to remain.
      expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      // Wrapped in `waitFor` — the persist effect that writes `pinned` to
      // `localStorage` is a genuine `useEffect`, so it can commit a tick
      // after the DOM assertion above already settled.
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("crs.dockSelectedRows") ?? "{}");
        expect(stored["1"].pinned).toBeNull();
      });
    });

    it("clears the pin when the currently-pinned row is selected as the new primary — no auto-swap", async () => {
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);
      await screen.findByTestId("terminal-pane");
      await user.click(screen.getByText("pin"));
      expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

      // Selecting "Worker" (the pinned row) as the new primary clears the
      // pin outright — it does NOT promote "dev" (the old primary) into
      // the now-empty pin slot.
      await user.click(screen.getByText("Worker"));

      await waitFor(() => {
        expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      });
      expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "20");
      expect(screen.queryByText("pinned")).not.toBeInTheDocument();
    });

    it("clears the pin when the PRIMARY row's own reconciliation (not a click) reassigns onto the pinned row", async () => {
      // Regression coverage for a real bug caught in review: the primary
      // selection's own neighbour-search reconciliation (this suite's
      // "clears pinnedKey ... when the pinned row's own control vanishes"
      // test above covers the reverse case) can land on the CURRENTLY
      // PINNED row when the old primary's row vanishes instead — nothing
      // upstream of this test's fix excluded the pinned row as a candidate
      // neighbour. Before the fix, this rendered two `DockLogPane`s for the
      // SAME session (a React duplicate-key warning) with no way to unpin
      // it, since the pin affordance is hidden on the now-selected row.
      const sessions = twoRunningControls();
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });
      const user = userEvent.setup();

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);
      // Adopt-on-empty selects "dev" (first live row); pin "worker".
      expect(await screen.findByTestId("terminal-pane")).toHaveAttribute("data-session-id", "10");
      await user.click(screen.getByText("pin"));
      expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

      // "dev" — the PRIMARY selection, not the pin — drops out of
      // discovery entirely (its own control removed, no session at all),
      // leaving "worker" (the pinned row) as the only surviving row. The
      // neighbour-search reconciliation has nowhere else to land but
      // "worker", which is exactly the collision this test exists to catch.
      dockByProject[1] = [{ id: "worker", title: "Worker", command: "npm run worker" }];
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [sessions[1]],
        sessionsLoaded: true,
      });
      useDashboardStore.getState().bumpDockConfigRefreshTrigger();

      await waitFor(() => {
        expect(screen.queryByText("Dev server")).not.toBeInTheDocument();
      });
      // Exactly one pane (the newly-primary "worker"), never two for the
      // same session, and the pin is gone rather than silently duplicated.
      const panes = screen.getAllByTestId("terminal-pane");
      expect(panes).toHaveLength(1);
      expect(panes[0]).toHaveAttribute("data-session-id", "20");
      expect(screen.queryByText("pinned")).not.toBeInTheDocument();
      // Wrapped in `waitFor`, not a synchronous read right after the render
      // assertions above — the persist effect that writes `pinned` to
      // `localStorage` is a genuine `useEffect` (Dock.tsx's own comment on
      // it), so it can commit a tick after the DOM updates this test just
      // asserted on. The "falls back to unpinned..." test further below
      // uses the same wrapped pattern for the same reason.
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("crs.dockSelectedRows") ?? "{}");
        expect(stored["1"].pinned).toBeNull();
      });
    });

    it("persists the pin across a remount, keyed by the same crs.dockSelectedRows entry #1238 already writes", async () => {
      const sessions = twoRunningControls();
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:dev", pinned: "dock-config:worker" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);

      const panes = await screen.findAllByTestId("terminal-pane");
      expect(panes).toHaveLength(2);
      expect(panes[0]).toHaveAttribute("data-session-id", "10");
      expect(panes[1]).toHaveAttribute("data-session-id", "20");
      expect(screen.getByText("pinned")).toBeInTheDocument();
    });

    it("falls back to unpinned when the previously-pinned control's identity no longer matches any row", async () => {
      const sessions = twoRunningControls();
      localStorage.setItem(
        "crs.dockSelectedRows",
        JSON.stringify({ "1": { selected: "dock-config:dev", pinned: "dock-config:ghost" } }),
      );
      useDashboardStore.setState({ projects: [PROJECT], sessions, sessionsLoaded: true });

      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      resizeTo(TWO_PANE_WIDTH);

      await screen.findByTestId("terminal-pane");
      expect(screen.getAllByTestId("terminal-pane")).toHaveLength(1);
      expect(screen.getByText("pin")).toBeInTheDocument();
      await waitFor(() => {
        const stored = JSON.parse(localStorage.getItem("crs.dockSelectedRows") ?? "{}");
        expect(stored["1"].pinned).toBeNull();
      });
    });

    // Issue #1244 — the draggable divider between the two panes. Extends
    // this suite (rather than a new sibling `describe`) to reuse its own
    // `resizeTo()`/`resizeCallbacks` ResizeObserver fake and threshold
    // constants above — the only other drag idiom in the repo is
    // useDragResize.test.ts's own hand-rolled `window.dispatchEvent(new
    // MouseEvent(...))` + fake mousedown pattern, reused here at component
    // level for what's the first such test in this file.
    //
    // Numbers below are all derived from the SAME defaults `logPaneMinWidth`
    // (364, dockHelpers.test.ts) and `railWidth`/`RAIL_DIVIDER_WIDTH_PX`/
    // `PANE_DIVIDER_WIDTH_PX` (Dock.tsx: 280 + 6 + 6 = 292) that
    // `ONE_PANE_WIDTH`/`TWO_PANE_WIDTH` above are: at TWO_PANE_WIDTH (1100),
    // `paneAreaWidth` (the two panes + their divider) is 1100 - 292 = 808,
    // so the legal ratio band is [364/808, 1 - 364/808] ≈ [0.4505, 0.5495].
    describe("issue #1244 — draggable pane divider", () => {
      function primaryPaneEl(): HTMLElement {
        return document.querySelectorAll(".dock-log-pane")[0] as HTMLElement;
      }

      function dividerEl(): HTMLElement {
        return document.querySelector(".dock-pane-divider") as HTMLElement;
      }

      it("drags the primary pane's flex-basis and persists a ratio keyed by the active workspace id", async () => {
        const sessions = twoRunningControls();
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 5,
        });
        const user = userEvent.setup();

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

        // Nothing stored yet for workspace 5 — starts at the 0.5 default:
        // 0.5 * 808 = 404px.
        expect(primaryPaneEl().style.flex).toBe("0 0 404px");

        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: 20 }));
        });
        // 404 + 20 = 424px, comfortably inside the legal band (max 444).
        expect(primaryPaneEl().style.flex).toBe("0 0 424px");

        act(() => {
          window.dispatchEvent(new MouseEvent("mouseup"));
        });

        const stored = JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}");
        expect(stored["5"]).toBeCloseTo(424 / 808);
      });

      it("clamps the drag so both panes stay at or above logPaneMinWidth", async () => {
        const sessions = twoRunningControls();
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 5,
        });
        const user = userEvent.setup();

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

        // Far past the LEFT edge — the primary pane's own floor wins
        // (logPaneMinWidth, 364), not a negative/zero width.
        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: -100_000 }));
        });
        expect(primaryPaneEl().style.flex).toBe("0 0 364px");
        act(() => {
          window.dispatchEvent(new MouseEvent("mouseup"));
        });

        // Far past the RIGHT edge — the PINNED pane's floor wins instead:
        // paneAreaWidth (808) - logPaneMinWidth (364) = 444.
        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: 100_000 }));
        });
        expect(primaryPaneEl().style.flex).toBe("0 0 444px");
        act(() => {
          window.dispatchEvent(new MouseEvent("mouseup"));
        });
      });

      it("clamps an out-of-range STORED ratio at render time without touching the stored value, and restores it once a wider column has room", async () => {
        const sessions = twoRunningControls();
        // 0.75 is legal in a WIDE column but pushes the pinned pane below
        // its floor at TWO_PANE_WIDTH (legal band there tops out at
        // ≈0.5495) — seeded directly, no drag involved, the exact gap the
        // issue's own scope statement misses.
        localStorage.setItem("crs.dockPaneSplitRatio", JSON.stringify({ "9": 0.75 }));
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 9,
        });

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        const user = userEvent.setup();
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

        // RENDERED basis is clamped to the column's own ceiling (808 - 364
        // = 444)...
        expect(primaryPaneEl().style.flex).toBe("0 0 444px");
        // ...while the STORED value is untouched — no drag happened, so
        // nothing should have rewritten it.
        expect(JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}")["9"]).toBe(0.75);

        // Widen well past the point 0.75 becomes legal again (paneAreaWidth
        // >= 364 / 0.25 = 1456, i.e. colWidth >= 1748): the user's actual
        // chosen ratio is honored again with no re-drag. 1800 -> paneAreaWidth
        // 1508 -> 0.75 * 1508 = 1131.
        resizeTo(1800);
        await waitFor(() => {
          expect(primaryPaneEl().style.flex).toBe("0 0 1131px");
        });
        expect(JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}")["9"]).toBe(0.75);
      });

      it("a stray click on the divider (mousedown/mouseup, no movement) does not overwrite a clamped stored ratio", async () => {
        // Regression coverage: `useDragResize`'s own `onUp` fires `onCommit`
        // unconditionally on every `mouseup`, including a bare click with no
        // `mousemove` in between — `lastValueRef` is seeded to `value` at
        // mousedown and never updated without a real move, so a no-op
        // "drag" commits with the CLAMPED render value
        // (`effectivePanePx`), not the raw stored ratio. Without a guard at
        // the call site, this would silently replace the user's actual
        // 0.75 with the narrow column's own clamped ≈0.5495 on every stray
        // click — for every column sharing this workspace's ratio, not just
        // this narrow one.
        const sessions = twoRunningControls();
        localStorage.setItem("crs.dockPaneSplitRatio", JSON.stringify({ "9": 0.75 }));
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 9,
        });

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        const user = userEvent.setup();
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);
        expect(primaryPaneEl().style.flex).toBe("0 0 444px");

        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mouseup")); // no mousemove
        });

        expect(JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}")["9"]).toBe(0.75);
      });

      it("persists a real drag that ends back at its own starting pixel (Hermes review) — a moved-during-drag flag, not final-vs-start px", async () => {
        // Regression coverage for a real bug caught in review on the FIRST
        // version of the stray-click guard above: that version compared
        // `onCommit`'s final px against the px captured at drag start, and
        // skipped the persist whenever they matched — which also matches a
        // completely genuine drag that moves away and back to the exact
        // same pixel before release. `onChange` fired (the divider visibly
        // moved), so this MUST persist; the guard has to track whether any
        // movement happened, not whether the net position changed.
        const sessions = twoRunningControls();
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 5,
        });
        const user = userEvent.setup();

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);
        expect(primaryPaneEl().style.flex).toBe("0 0 404px"); // 0.5 default

        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: 20 })); // -> 424px
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: 0 })); // back to 404px
        });
        expect(primaryPaneEl().style.flex).toBe("0 0 404px");
        act(() => {
          window.dispatchEvent(new MouseEvent("mouseup"));
        });

        const stored = JSON.parse(localStorage.getItem("crs.dockPaneSplitRatio") ?? "{}");
        expect(stored["5"]).toBeCloseTo(404 / 808);
      });

      it("shares the ratio across columns in one workspace, each clamping independently against its own width", async () => {
        const PROJECT2 = makeProject({ id: 2, name: "second", cwd: "/home/x/second" });
        dockByProject[1] = [
          { id: "dev", title: "Dev server", command: "npm run dev" },
          { id: "worker", title: "Worker", command: "npm run worker" },
        ];
        dockByProject[2] = [
          { id: "dev", title: "Dev server", command: "npm run dev" },
          { id: "worker", title: "Worker", command: "npm run worker" },
        ];
        const sessions = [
          makeSession({
            id: 10,
            projectId: 1,
            command: "npm run dev",
            kind: "dock",
            status: "active",
          }),
          makeSession({
            id: 20,
            projectId: 1,
            command: "npm run worker",
            kind: "dock",
            status: "active",
          }),
          makeSession({
            id: 30,
            projectId: 2,
            command: "npm run dev",
            kind: "dock",
            status: "active",
          }),
          makeSession({
            id: 40,
            projectId: 2,
            command: "npm run worker",
            kind: "dock",
            status: "active",
          }),
        ];
        localStorage.setItem("crs.dockPaneSplitRatio", JSON.stringify({ "3": 0.6 }));
        useDashboardStore.setState({
          projects: [PROJECT, PROJECT2],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: 3,
        });
        const user = userEvent.setup();

        render(
          <Dock workspaceProjectIds={[1, 2]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        // Assert there are exactly two columns, and identify them by their
        // own `.dock-column-name` text (project name) — NOT by array index —
        // before assuming `resizeCallbacks[0]`/`[1]` line up with
        // project 1/2 in mount order. If that assumption were ever wrong,
        // both `toBe` assertions below would still be plausible values (444
        // and 905 both genuinely occur, just on the wrong column), so this
        // anchors the mapping explicitly rather than trusting index
        // arithmetic silently.
        const columns = Array.from(document.querySelectorAll(".dock-column"));
        expect(columns).toHaveLength(2);
        const mullionColumnIndex = columns.findIndex((c) =>
          c.querySelector(".dock-column-name")?.textContent?.includes("mullion"),
        );
        const secondColumnIndex = columns.findIndex((c) =>
          c.querySelector(".dock-column-name")?.textContent?.includes("second"),
        );
        expect(mullionColumnIndex).not.toBe(-1);
        expect(secondColumnIndex).not.toBe(-1);

        // Column "mullion" (project 1) narrower (TWO_PANE_WIDTH,
        // paneAreaWidth 808 — 0.6 is above that column's own ≈0.5495
        // ceiling); column "second" (project 2) wider (paneAreaWidth 1508 —
        // 0.6 is comfortably inside its own band). `resizeCallbacks` fires
        // in the same order DockColumn instances mounted, which matches
        // `columnIds`/mount order — asserted against the column identities
        // above rather than assumed.
        act(() => {
          resizeCallbacks[mullionColumnIndex]?.([{ contentRect: { width: TWO_PANE_WIDTH } }]);
          resizeCallbacks[secondColumnIndex]?.([{ contentRect: { width: 1800 } }]);
        });

        await screen.findAllByTestId("terminal-pane");
        const pinTags = screen.getAllByText("pin");
        expect(pinTags).toHaveLength(2);
        await user.click(pinTags[0]);
        await user.click(pinTags[1]);
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(4);

        const mullionPrimaryPane = columns[mullionColumnIndex]!.querySelector(
          ".dock-log-pane",
        ) as HTMLElement;
        const secondPrimaryPane = columns[secondColumnIndex]!.querySelector(
          ".dock-log-pane",
        ) as HTMLElement;
        // "mullion"'s primary pane clamps to its own ceiling (444);
        // "second"'s primary pane honors 0.6 unclamped: 0.6 * 1508 = 905
        // (rounded).
        expect(mullionPrimaryPane.style.flex).toBe("0 0 444px");
        expect(secondPrimaryPane.style.flex).toBe("0 0 905px");
      });

      it("defaults to a 0.5 split and persists nothing when there is no active workspace", async () => {
        const sessions = twoRunningControls();
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions,
          sessionsLoaded: true,
          activeWorkspaceId: null,
        });
        const user = userEvent.setup();

        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        resizeTo(TWO_PANE_WIDTH);
        await screen.findByTestId("terminal-pane");
        await user.click(screen.getByText("pin"));
        expect(await screen.findAllByTestId("terminal-pane")).toHaveLength(2);

        expect(primaryPaneEl().style.flex).toBe("0 0 404px");

        fireEvent.mouseDown(dividerEl(), { clientX: 0 });
        act(() => {
          window.dispatchEvent(new MouseEvent("mousemove", { clientX: 20 }));
          window.dispatchEvent(new MouseEvent("mouseup"));
        });

        expect(localStorage.getItem("crs.dockPaneSplitRatio")).toBeNull();
      });
    });
  });

  describe("Docker Compose services (issue #73)", () => {
    function dockerControl(overrides: Record<string, unknown> = {}) {
      return {
        id: "docker:sanctuary:web",
        title: "web",
        command:
          "docker compose -p 'sanctuary' --project-directory '/x/sanctuary' logs -f --tail=200 'web'",
        source: "docker",
        docker: {
          composeProject: "sanctuary",
          service: "web",
          containerName: "sanctuary-web",
          state: "running",
          status: "Up 6 days",
          imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
          imageId: "sha256:current",
          buildOnly: false,
        },
        ...overrides,
      };
    }

    // Two DIFFERENT kebabs now coexist for a single discovered service: the
    // per-service one inside .dock-monitor-header (Restart/Stop/Start
    // service, Check for update) and the per-compose-project one inside
    // .dock-stack-header (Restart/Apply/Pull-or-Rebuild/Stop stack) —
    // hoisted out of the row so it stops repeating once per service in the
    // same stack. A plain `document.querySelector(".kebab-trigger-btn")`
    // would silently grab whichever renders first in the DOM, so every test
    // below picks the one it actually means to exercise.
    function serviceKebab(): HTMLElement {
      return document.querySelector(".dock-monitor-header .kebab-trigger-btn") as HTMLElement;
    }
    function stackKebab(): HTMLElement {
      return document.querySelector(".dock-stack-header .kebab-trigger-btn") as HTMLElement;
    }

    it("renders a discovered control under its compose-project stack header, with a status dot, image pill, and kebab", async () => {
      dockByProject[1] = [
        { id: "dev", title: "Dev server", command: "npm run dev" },
        dockerControl(),
      ];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      expect(await screen.findByText("Dev server")).toBeInTheDocument();
      expect(screen.getByText("sanctuary")).toHaveClass("dock-group-label");
      expect(screen.getByText("web")).toBeInTheDocument();
      expect(screen.getByText("edge")).toBeInTheDocument();
      expect(serviceKebab()).toBeInTheDocument();
      expect(stackKebab()).toBeInTheDocument();
      // The kebab wrapper carries .dock-monitor-kebab (pinned flex-shrink:0
      // in CSS) so a squeezed header never clips it. jsdom does no layout —
      // this only proves the class is wired up, not that the kebab stays
      // visible at a real narrow width. That's a manual check (see this
      // repo's dock kebab plan / PR description), not something a jsdom
      // test can assert.
      expect(serviceKebab().parentElement).toHaveClass("dock-monitor-kebab");
      expect(stackKebab().parentElement).toHaveClass("dock-monitor-kebab");
    });

    it("clicking the service kebab trigger does not toggle the monitor on/off", async () => {
      dockByProject[1] = [dockerControl()];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], createSession });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());

      expect(await screen.findByText("Check for update")).toBeInTheDocument();
      expect(createSession).not.toHaveBeenCalled();
    });

    it("the service kebab no longer offers any stack-wide action — only service-scoped ones", async () => {
      dockByProject[1] = [dockerControl()];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());

      expect(await screen.findByText("Check for update")).toBeInTheDocument();
      expect(screen.getByText("Restart service")).toBeInTheDocument();
      expect(screen.getByText("Stop service")).toBeInTheDocument();
      expect(screen.queryByText("Restart stack")).not.toBeInTheDocument();
      expect(screen.queryByText("Apply config")).not.toBeInTheDocument();
      expect(screen.queryByText("Pull & restart stack")).not.toBeInTheDocument();
      expect(screen.queryByText("Stop stack")).not.toBeInTheDocument();
    });

    describe("auto-attach Docker logs (PR3, settings.dock.autoAttachDockerLogs)", () => {
      it("does not auto-attach a running container's logs when the setting is off (default)", async () => {
        dockByProject[1] = [dockerControl()];
        const createSession = vi.fn().mockResolvedValue({});
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          createSession,
          settings: { ...DEFAULT_SETTINGS, dock: { ...DEFAULT_SETTINGS.dock } },
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        expect(createSession).not.toHaveBeenCalled();
      });

      it("auto-attaches a running container with no session when the setting is on", async () => {
        dockByProject[1] = [dockerControl()];
        const createSession = vi.fn().mockResolvedValue({});
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          sessionsLoaded: true,
          createSession,
          settings: {
            ...DEFAULT_SETTINGS,
            dock: { ...DEFAULT_SETTINGS.dock, autoAttachDockerLogs: true },
          },
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await waitFor(() => {
          expect(createSession).toHaveBeenCalledWith(1, dockerControl().command, {
            kind: "dock",
            name: "docker-logs:sanctuary-web",
            nameLocked: true,
          });
        });
      });

      it("does not fight a manual stop — a poll that still shows the container running does not re-attach", async () => {
        dockByProject[1] = [dockerControl()];
        const createSession = vi.fn().mockResolvedValue({});
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          sessionsLoaded: true,
          createSession,
          settings: {
            ...DEFAULT_SETTINGS,
            dock: { ...DEFAULT_SETTINGS.dock, autoAttachDockerLogs: true },
          },
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

        // Simulate the user manually stopping the log stream (deleteSession)
        // — the session is gone, but the container itself (dockByProject)
        // never stopped, so this is NOT a state transition.
        useDashboardStore.setState({ sessions: [] });
        dockByProject[1] = [dockerControl()]; // fresh array; state still "running"
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();

        await screen.findByText("web");
        // Flush the refetch's promise chain before asserting no wrongful
        // second call landed.
        await new Promise((r) => setTimeout(r, 0));
        expect(createSession).toHaveBeenCalledTimes(1);
      });

      it("re-attaches after the container disappears from discovery entirely and comes back (compose down/up)", async () => {
        // Hermes review — the eligibility map used to grow monotonically,
        // never dropping an identity absent from the current poll. A plain
        // container-state change ("running" -> "exited") is covered by the
        // "does not fight a manual stop" test above, but `docker compose
        // down` removes the container from `docker ps -a` entirely, so the
        // control vanishes from discovery rather than merely changing
        // state — without pruning, the stale `true` survived that gap and
        // silently suppressed the re-attach edge once `up -d` recreated it.
        dockByProject[1] = [dockerControl()];
        const createSession = vi.fn().mockResolvedValue({});
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          sessionsLoaded: true,
          createSession,
          settings: {
            ...DEFAULT_SETTINGS,
            dock: { ...DEFAULT_SETTINGS.dock, autoAttachDockerLogs: true },
          },
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await waitFor(() => expect(createSession).toHaveBeenCalledTimes(1));

        // "docker compose down" — the control disappears from discovery.
        // PR2b: the row no longer vanishes instantly — it's held (labeled
        // "recreating…") for RECREATE_GRACE_MS, so a brief mid-rebuild
        // discovery gap doesn't resize every sibling monitor. The auto-attach
        // effect this test is actually about reads the RAW (un-held) poll
        // result, so its own eligibility prune fires exactly as before —
        // proven below by the second createSession call, not by the row's
        // own visibility.
        dockByProject[1] = [];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();
        await screen.findByText("recreating…");

        // "docker compose up -d" — same identity, running again, no session.
        dockByProject[1] = [dockerControl()];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();

        await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.queryByText("recreating…")).not.toBeInTheDocument());
      });

      it("shows a transient status instead of an unhandled rejection when the auto-attach itself fails", async () => {
        dockByProject[1] = [dockerControl()];
        const createSession = vi.fn().mockRejectedValue(new Error("no free pty slots"));
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          sessionsLoaded: true,
          createSession,
          settings: {
            ...DEFAULT_SETTINGS,
            dock: { ...DEFAULT_SETTINGS.dock, autoAttachDockerLogs: true },
          },
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const status = await screen.findByText("Auto-attach failed");
        expect(status).toHaveClass("dock-monitor-check-status", "error");
      });

      it("retries a failed auto-attach once the cooldown elapses, without waiting for a real eligibility edge", async () => {
        // Hermes review, round 2 — recording `eligible: true` on a FAILED
        // attempt (indistinguishable from a successful one) meant the
        // false→true edge that's supposed to retry never fired again for
        // that identity until the container itself cycled through
        // non-running or the setting was toggled — a single transient
        // failure permanently and silently lost auto-attach for a
        // long-lived container. `Date.now()` is mocked (not real timers)
        // so this doesn't need to actually wait 60s.
        const T0 = 1_700_000_000_000;
        const dateSpy = vi.spyOn(Date, "now").mockReturnValue(T0);
        try {
          dockByProject[1] = [dockerControl()];
          const createSession = vi.fn().mockRejectedValueOnce(new Error("no free pty slots"));
          useDashboardStore.setState({
            projects: [PROJECT],
            sessions: [],
            sessionsLoaded: true,
            createSession,
            settings: {
              ...DEFAULT_SETTINGS,
              dock: { ...DEFAULT_SETTINGS.dock, autoAttachDockerLogs: true },
            },
          });
          render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

          await screen.findByText("Auto-attach failed");
          expect(createSession).toHaveBeenCalledTimes(1);

          // Still within the cooldown — a poll must NOT retry yet.
          createSession.mockResolvedValue({});
          dockByProject[1] = [dockerControl()];
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();
          await screen.findByText("web");
          await new Promise((r) => setTimeout(r, 0));
          expect(createSession).toHaveBeenCalledTimes(1);

          // Cooldown elapsed — the next poll retries even with no state
          // transition at all.
          dateSpy.mockReturnValue(T0 + 61_000);
          dockByProject[1] = [dockerControl()];
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();

          await waitFor(() => expect(createSession).toHaveBeenCalledTimes(2));
        } finally {
          dateSpy.mockRestore();
        }
      });
    });

    describe("PR2b — holding a docker control across a brief discovery gap", () => {
      it("keeps a vanished service's row and its running terminal mounted (same DOM node, not unmounted+remounted), labeled recreating…", async () => {
        dockByProject[1] = [dockerControl()];
        const runningSession = makeSession({
          id: 42,
          kind: "dock",
          name: "docker-logs:sanctuary-web",
          command: dockerControl().command,
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [runningSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        // Captured by reference — this is the assertion that actually pins
        // "stayed mounted" vs. "unmounted, then a different instance
        // remounted": a getBy* re-query alone can't tell the two apart,
        // since both would satisfy toBeInTheDocument() once settled.
        const paneBefore = screen.getByTestId("terminal-pane");

        // "compose up -d" recreate: the old container is deleted before the
        // new one appears, so the service is briefly absent from discovery.
        dockByProject[1] = [];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();

        await screen.findByText("recreating…");
        // The row — and its still-live log session's terminal — stays
        // mounted rather than unmounting for the gap.
        expect(screen.getByText("web")).toBeInTheDocument();
        expect(screen.getByTestId("terminal-pane")).toBe(paneBefore);

        // New container appears with the same identity.
        dockByProject[1] = [dockerControl()];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();

        await waitFor(() => expect(screen.queryByText("recreating…")).not.toBeInTheDocument());
        expect(screen.getByText("web")).toBeInTheDocument();
        expect(screen.getByTestId("terminal-pane")).toBe(paneBefore);
      });

      it("hides the kebab and makes the row/stream-toggle inert while held — control.docker is a frozen pre-vanish snapshot the backend can't resolve", async () => {
        // Hermes review, PR #1176 — before this, the kebab's "Restart
        // service"/"Stop service"/"Check for update" and the header's own
        // start/kill both stayed live against `control.docker` while held,
        // even though that snapshot no longer matches anything live
        // discovery knows about — every one of those actions would 404
        // into a failure toast for the ~1 poll interval the row is held.
        // Dock master-detail rework — `role="button"`/`aria-disabled` moved
        // from `.dock-monitor-header` up to `.dock-monitor` itself
        // (DockMonitor.tsx's own comment on why), and killing a running
        // stream moved from the row's own click to the trailing tag's —
        // this test now pins BOTH relocations, not just the kebab.
        dockByProject[1] = [dockerControl()];
        const runningSession = makeSession({
          id: 42,
          kind: "dock",
          name: "docker-logs:sanctuary-web",
          command: dockerControl().command,
        });
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [runningSession],
          sessionsLoaded: true,
          deleteSession,
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        expect(document.querySelector(".dock-monitor .kebab-trigger-btn")).not.toBeNull();
        expect(document.querySelector(".dock-monitor")).not.toHaveAttribute(
          "aria-disabled",
          "true",
        );
        // The stream-toggle tag is interactive (carries its own class and
        // role) while not held.
        expect(document.querySelector(".dock-monitor-stream-toggle")).not.toBeNull();

        dockByProject[1] = [];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();
        await screen.findByText("recreating…");

        // The kebab is gone entirely rather than merely disabled.
        expect(document.querySelector(".dock-monitor .kebab-trigger-btn")).toBeNull();
        const row = document.querySelector(".dock-monitor") as HTMLElement;
        expect(row).toHaveAttribute("aria-disabled", "true");
        // The tag renders as a plain, non-interactive span while held — no
        // role/onClick, so clicking it can't 404 against a container
        // discovery no longer knows about.
        expect(document.querySelector(".dock-monitor-stream-toggle")).toBeNull();
        expect(screen.getByText("logs on")).not.toHaveAttribute("role");

        // Neither the row's own click (which only ever SELECTS, never
        // kills — see DockMonitor.tsx) nor the (now absent) tag can fire
        // deleteSession while held.
        await user.click(screen.getByText("web"));
        await new Promise((r) => setTimeout(r, 0));
        expect(deleteSession).not.toHaveBeenCalled();

        // Same for the keyboard path (P10) — Enter/Space on the held row is
        // also a no-op.
        row.focus();
        await user.keyboard("{Enter}");
        await new Promise((r) => setTimeout(r, 0));
        expect(deleteSession).not.toHaveBeenCalled();
      });

      it("drops the row once the grace window elapses without the service reappearing", async () => {
        // Date.now() mocked (not real timers) — same technique as the
        // auto-attach cooldown test above — so this doesn't need to
        // actually wait out RECREATE_GRACE_MS.
        const T0 = 1_700_000_000_000;
        const dateSpy = vi.spyOn(Date, "now").mockReturnValue(T0);
        try {
          dockByProject[1] = [dockerControl()];
          useDashboardStore.setState({ projects: [PROJECT], sessions: [], sessionsLoaded: true });
          render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
          await screen.findByText("web");

          dockByProject[1] = [];
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();
          await screen.findByText("recreating…");

          // Still within the grace window (RECREATE_GRACE_MS = 2 poll
          // intervals + a 5s margin, Dock.tsx) — a poll must keep holding it.
          dateSpy.mockReturnValue(T0 + 34_000);
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();
          await new Promise((r) => setTimeout(r, 0));
          expect(screen.queryByText("web")).toBeInTheDocument();

          // Grace elapsed with no reappearance — the row finally drops.
          dateSpy.mockReturnValue(T0 + 36_000);
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();
          await waitFor(() => expect(screen.queryByText("web")).not.toBeInTheDocument());
        } finally {
          dateSpy.mockRestore();
        }
      });
    });

    // Previously uncovered (issue #73 follow-up plan) — every other test in
    // this describe block exercises the kebab menu, never the header click
    // that actually starts the log stream for a `source: "docker"` control.
    it("clicking the header starts the log-stream session for a discovered Docker control", async () => {
      dockByProject[1] = [dockerControl()];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], createSession });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = await screen.findByText("web");
      expect(screen.getByText("logs off")).toBeInTheDocument();
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, dockerControl().command, {
        cwd: undefined,
        kind: "dock",
        name: "docker-logs:sanctuary-web",
        nameLocked: true,
      });
    });

    it("PR3 — a running dock monitor's terminal gets inputAffordances={false} — no attach-image or mic button over a log stream", async () => {
      dockByProject[1] = [dockerControl()];
      const runningSession = makeSession({
        id: 42,
        kind: "dock",
        name: "docker-logs:sanctuary-web",
        command: dockerControl().command,
      });
      useDashboardStore.setState({ projects: [PROJECT], sessions: [runningSession] });
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const pane = await screen.findByTestId("terminal-pane");
      expect(pane).toHaveAttribute("data-input-affordances", "false");
    });

    it("dock master-detail rework — the column's one log pane carries an inline min-width/min-height (on .dock-log-pane itself, not its body) derived from the user's live terminal settings", async () => {
      // Confirmed live (pre-rework): without an explicit floor on the right
      // element, every dock terminal was permanently below pty-manager.ts's
      // MIN_TERMINAL_ROWS (10) on any dock height (a real GeometryMessage
      // echo read {"cols":63,"rows":10,"minCols":40,"minRows":10} — rows
      // floored exactly at the minimum), which latches TerminalPane's
      // cappedBelowFloor permanently true and skips applyClampedFit() from
      // ever running. The floor has to be applied to `.dock-log-pane`
      // itself, not `.dock-log-pane-body` — the same review-caught bug this
      // test's predecessor pinned for `.dock-monitor`/`.dock-monitor-body`,
      // now on the box that actually holds the terminal post-rework.
      dockByProject[1] = [dockerControl()];
      const runningSession = makeSession({
        id: 42,
        kind: "dock",
        name: "docker-logs:sanctuary-web",
        command: dockerControl().command,
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [runningSession],
        settings: {
          ...DEFAULT_SETTINGS,
          terminal: { ...DEFAULT_SETTINGS.terminal, fontSize: 14, padding: 4 },
        },
      });
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const pane = await screen.findByTestId("terminal-pane");
      const body = pane.closest(".dock-log-pane-body") as HTMLElement;
      const logPane = body.closest(".dock-log-pane") as HTMLElement;
      // dockMonitorMinWidthPx(14, 4) === 364, dockMonitorMinHeightPx(14, 4)
      // === 201 — the BODY-only number, not the full 231 the old
      // .dock-monitor floor used: `.dock-log-pane` has no 28px header of
      // its own to add back in. See dockHelpers.test.ts's own worked
      // derivations for both.
      expect(logPane.style.minWidth).toBe("364px");
      expect(logPane.style.minHeight).toBe("201px");
      // The body itself carries no inline min-height/min-width of its own —
      // the pane's own explicit floor is what has to force room for it, per
      // the mechanism this test's own header comment documents.
      expect(body.style.minHeight).toBe("");
      expect(body.style.minWidth).toBe("");
    });

    it("'Check for update' calls the check-update endpoint and tints the image pill on an update", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = {
        updateAvailable: true,
        currentImageId: "sha256:current",
        latestImageId: "sha256:new",
        imageRef: "ghcr.io/s3ntin3l8/sanctuary:edge",
        checkedAt: "2026-01-01T00:00:00.000Z",
      };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());
      await user.click(await screen.findByText("Check for update"));

      await waitFor(() => {
        expect(screen.getByText("edge").closest(".dock-monitor-image")).toHaveClass(
          "dock-monitor-image-update",
        );
      });
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/projects/1/docker/check-update",
        expect.objectContaining({ method: "POST" }),
      );
    });

    // Hermes review — a pull-failed/up-to-date check result was stored but
    // never surfaced anywhere, so a slow or failed check read as "nothing
    // happened."
    it("shows a transient 'Up to date' status when no update is available", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = { updateAvailable: false };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());
      await user.click(await screen.findByText("Check for update"));

      const status = await screen.findByText("Up to date");
      expect(status).toHaveClass("dock-monitor-check-status");
      expect(status).not.toHaveClass("error");
    });

    it("shows a transient error status when the check-update pull fails", async () => {
      dockByProject[1] = [dockerControl()];
      checkUpdateByProject[1] = { updateAvailable: false, reason: "pull-failed" };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());
      await user.click(await screen.findByText("Check for update"));

      const status = await screen.findByText("Check failed — pull error");
      expect(status).toHaveClass("dock-monitor-check-status", "error");
    });

    it("does not mangle a digest image ref into the literal string 'sha256'", async () => {
      dockByProject[1] = [
        dockerControl({
          docker: {
            ...dockerControl().docker,
            imageRef:
              "ghcr.io/s3ntin3l8/sanctuary@sha256:c14dd0e39e89f0c15c2bf462d8a2e05fb17a3b89dc8fe59b60e9f7daa48d7837",
          },
        }),
      ];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      expect(screen.queryByText("sha256")).not.toBeInTheDocument();
      expect(
        document.querySelector(".dock-monitor-image .dock-monitor-url-text")?.textContent,
      ).toMatch(/^sha256:[0-9a-f]{12}$/);
    });

    it("'Pull & restart stack' requires arming (two clicks) before it fires", async () => {
      dockByProject[1] = [dockerControl()];
      updateByProject[1] = {
        sessionId: 42,
        control: {
          id: "docker-update:sanctuary",
          title: "Update sanctuary",
          command:
            "docker compose -p 'sanctuary' ... pull && docker compose -p 'sanctuary' ... up -d",
          source: "docker",
        },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(stackKebab());
      const item = await screen.findByText("Pull & restart stack");

      await user.click(item);
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/update",
        expect.anything(),
      );
      expect(await screen.findByText("Click again — restarts the whole stack")).toBeInTheDocument();

      await user.click(screen.getByText("Click again — restarts the whole stack"));

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/update",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("dock master-detail rework — a live stack-action control renders as an ordinary rail row after its stack's services, not inside .dock-stack-monitors", async () => {
      // Superseded history: originally (PR2a) rebuilding a stack opened a
      // second CARD inside .dock-stack-monitors, N-way splitting "web"'s
      // WIDTH with the new panel via the group's own flexGrow — fixed (PR2b
      // era) by moving it into its own `.dock-stack-action-strip` sibling
      // instead. The master-detail rework removes the strip entirely: every
      // row (service or stack-action) is now a 28px rail row with no
      // per-row width to fight over in the first place, so there's nothing
      // left for a special strip to protect against — an ephemeral control
      // just renders where any other row would, after its stack's services.
      dockByProject[1] = [dockerControl()]; // just "web"
      const rebuildCommand =
        "docker compose -p 'sanctuary' build --pull && docker compose -p 'sanctuary' up -d";
      updateByProject[1] = {
        sessionId: 42,
        control: {
          id: "docker-update:sanctuary",
          title: "Update sanctuary",
          command: rebuildCommand,
          source: "docker",
        },
      };
      const rebuildSession = makeSession({
        id: 42,
        kind: "dock",
        command: rebuildCommand,
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [rebuildSession],
        refreshSessions: vi.fn().mockResolvedValue(undefined),
      });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(stackKebab());
      await user.click(await screen.findByText("Pull & restart stack"));
      await user.click(await screen.findByText("Click again — restarts the whole stack"));

      // The ephemeral "Update sanctuary" row is a sibling of
      // .dock-stack-monitors within the group — not inside it.
      const transientRow = await screen.findByText("Update sanctuary");
      const transientMonitor = transientRow.closest(".dock-monitor") as HTMLElement;
      expect(transientMonitor.closest(".dock-stack-monitors")).toBeNull();
      const group = document.querySelector(".dock-stack-group") as HTMLElement;
      expect(group.contains(transientMonitor)).toBe(true);

      // "web" is still the only control inside .dock-stack-monitors.
      const servicesRow = document.querySelector(".dock-stack-monitors") as HTMLElement;
      expect(servicesRow.querySelectorAll(".dock-monitor")).toHaveLength(1);
      expect(servicesRow.textContent).toContain("web");

      // No `.dock-stack-action-strip` anywhere — the mechanism it existed
      // for (protecting a service row's WIDTH share) doesn't apply to a
      // column of uniform 28px rows.
      expect(document.querySelector(".dock-stack-action-strip")).toBeNull();
      // Nor an inline flexGrow — every row is content-sized now.
      expect(group.style.flexGrow).toBe("");
    });

    it("dock log-streaming resize fix (symptom 3) — a live stack action survives a workspace switch, reconstructed from its session", async () => {
      // Before this fix, Dock.tsx's `ephemeralControls` was component-local
      // useState, populated only by the POST response that started the
      // action — a workspace switch unmounts the whole DockColumn (this
      // component's own parent), losing that state even though the backend
      // session (named `docker-stack:<composeProject>`, nameLocked) is
      // untouched. Simulated here by re-rendering with `workspaceProjectIds`
      // dropping project 1 and then bringing it back — the same unmount/
      // remount App.tsx's own workspaceProjectIds derivation puts a
      // DockColumn through on a real workspace switch.
      dockByProject[1] = [dockerControl()]; // just "web"
      const rebuildCommand =
        "docker compose -p 'sanctuary' build --pull && docker compose -p 'sanctuary' up -d";
      updateByProject[1] = {
        sessionId: 42,
        control: {
          id: "docker-update:sanctuary",
          title: "Update sanctuary",
          command: rebuildCommand,
          source: "docker",
          composeProject: "sanctuary",
        },
      };
      // The real backend always names a stack-action session
      // `docker-stack:<composeProject>` (stackSessionName, routes/
      // projects.ts) — that's the identity the reconstruction below reads.
      const rebuildSession = makeSession({
        id: 42,
        kind: "dock",
        name: "docker-stack:sanctuary",
        command: rebuildCommand,
      });
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [rebuildSession],
        refreshSessions: vi.fn().mockResolvedValue(undefined),
      });
      const user = userEvent.setup();
      const { rerender } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("web");
      await user.click(stackKebab());
      await user.click(await screen.findByText("Pull & restart stack"));
      await user.click(await screen.findByText("Click again — restarts the whole stack"));
      await screen.findByText("Update sanctuary");

      // Workspace switch away — DockColumn (and its ephemeralControls
      // state) unmounts. The session itself is untouched in the store.
      rerender(<Dock workspaceProjectIds={[]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      expect(screen.queryByText("web")).not.toBeInTheDocument();

      // Workspace switch back — a fresh DockColumn mount, with none of its
      // own optimistic ephemeralControls state.
      rerender(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      await screen.findByText("web");

      // The row is back, reconstructed from the still-live session — its
      // title is the reconstruction's own generic "Stack action running —
      // sanctuary" (Dock.tsx's reconstructedEphemeralControls), not the
      // original "Update sanctuary" the optimistic control had before the
      // unmount lost it (deliberately: the verb was never persisted
      // anywhere durable to recover it from — see Dock.tsx's own comment).
      // Grouped correctly under "sanctuary" via the reconstructed control's
      // own `composeProject` field (issue #1112), not left in `ungrouped`.
      const transientRow = screen.getByText("Stack action running — sanctuary");
      const group = document.querySelector(".dock-stack-group") as HTMLElement;
      expect(group.contains(transientRow)).toBe(true);
      expect(document.querySelector(".dock-stack-action-strip")).toBeNull();

      // Hermes review — a persistent "running" indicator lives in the
      // always-visible DockStackHeader, independent of the transient status
      // message (which only ever fires from a click, never from this
      // reconstruction path).
      expect(screen.getByTitle("A stack action is running — see the log row below")).toHaveClass(
        "dock-stack-action-running",
      );
    });

    it("Hermes review — no persistent 'running' indicator when nothing is running", async () => {
      dockByProject[1] = [dockerControl()];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      expect(document.querySelector(".dock-stack-action-running")).toBeNull();
    });

    it("Hermes review — .dock-stack-monitors doesn't render when a group has no service controls left", async () => {
      // Every service dropped from discovery past its own RECREATE_GRACE_MS
      // hold, leaving only the live ephemeral stack-action control — a
      // narrow but real case (PR2b's own grace-window expiry test below
      // reaches it the same way). Originally (pre-master-detail-rework)
      // .dock-stack-monitors still rendered with its inline min-height,
      // reserving ~231px of dead space with nothing inside it; post-rework
      // an empty content-sized column costs nothing layout-wise either way,
      // but it's skipped anyway as a plain "don't render a pointless empty
      // wrapper" cleanup (Dock.tsx).
      const T0 = 1_700_000_000_000;
      const dateSpy = vi.spyOn(Date, "now").mockReturnValue(T0);
      try {
        dockByProject[1] = [dockerControl()];
        const rebuildCommand =
          "docker compose -p 'sanctuary' build --pull && docker compose -p 'sanctuary' up -d";
        updateByProject[1] = {
          sessionId: 42,
          control: {
            id: "docker-update:sanctuary",
            title: "Update sanctuary",
            command: rebuildCommand,
            source: "docker",
            composeProject: "sanctuary",
          },
        };
        const rebuildSession = makeSession({ id: 42, kind: "dock", command: rebuildCommand });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [rebuildSession],
          refreshSessions: vi.fn().mockResolvedValue(undefined),
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        await user.click(stackKebab());
        await user.click(await screen.findByText("Pull & restart stack"));
        await user.click(await screen.findByText("Click again — restarts the whole stack"));
        await screen.findByText("Update sanctuary");

        // The container vanishes mid-rebuild (recreate) — held at first,
        // then the grace window itself expires (same two-step poll the
        // "floors a group's flexGrow at 1" test below uses).
        dockByProject[1] = [];
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();
        await screen.findByText("recreating…");

        dateSpy.mockReturnValue(T0 + 36_000);
        useDashboardStore.getState().bumpDockConfigRefreshTrigger();
        await waitFor(() => expect(screen.queryByText("web")).not.toBeInTheDocument());

        expect(document.querySelector(".dock-stack-monitors")).toBeNull();
        // The ephemeral row itself is untouched — only the (now genuinely
        // empty) services block is gone. No `.dock-stack-action-strip`
        // exists post-rework; the row lives directly in `.dock-stack-group`.
        const group = document.querySelector(".dock-stack-group") as HTMLElement;
        expect(group.textContent).toContain("Update sanctuary");
      } finally {
        dateSpy.mockRestore();
      }
    });

    it("a build-only service disables Check for update but offers an enabled Rebuild & restart, not a disabled Pull & restart", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, buildOnly: true } }),
      ];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());

      await screen.findByText("Check for update");
      const checkBtn = screen.getByText("Check for update").closest("button");
      // Issue #1106 — aria-disabled, not the native `disabled` attribute
      // (see KebabMenu.tsx's own comment): a `disabled` button can't
      // reliably carry an explanatory `title`, so the click guard lives in
      // handleItemClick instead and this stays presentational.
      expect(checkBtn).toHaveAttribute("aria-disabled", "true");
      expect(checkBtn).not.toBeDisabled();
      expect(checkBtn).toHaveAttribute(
        "title",
        "No registry image to compare — this service is built from source",
      );

      // The bug #857 fixed: previously BOTH menu items were disabled for a
      // build-only stack, leaving no lifecycle action reachable at all. Now
      // on the stack kebab (hoisted out of the service row — see this
      // describe block's own serviceKebab/stackKebab helpers).
      await user.click(stackKebab());
      expect(screen.queryByText("Pull & restart stack")).not.toBeInTheDocument();
      const rebuildBtn = await screen.findByText("Rebuild & restart stack");
      expect(rebuildBtn.closest("button")).not.toBeDisabled();
    });

    it("'Rebuild & restart stack' requires arming before it fires the rebuild route", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, buildOnly: true } }),
      ];
      rebuildByProject[1] = {
        sessionId: 43,
        control: { id: "docker-rebuild:sanctuary", title: "Rebuild sanctuary", source: "docker" },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(stackKebab());
      await user.click(await screen.findByText("Rebuild & restart stack"));

      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/stack/rebuild",
        expect.anything(),
      );
      await user.click(
        await screen.findByText("Click again — rebuilds and restarts the whole stack"),
      );

      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/rebuild",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();
    });

    it("service Restart/Start fire immediately (no arming) and Stop requires arming", async () => {
      dockByProject[1] = [
        dockerControl({ docker: { ...dockerControl().docker, state: "exited" } }),
      ];
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());

      await user.click(await screen.findByText("Restart service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/restart",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(serviceKebab());
      // state:"exited" (≠ running) — "Start service" must be offered.
      await user.click(await screen.findByText("Start service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/start",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(serviceKebab());
      await user.click(await screen.findByText("Stop service"));
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/service/stop",
        expect.anything(),
      );
      await user.click(await screen.findByText("Click again — stops this service"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/service/stop",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("does not offer 'Start service' when the container is already running", async () => {
      dockByProject[1] = [dockerControl()]; // default state: "running"
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const user = userEvent.setup();
      await screen.findByText("web");
      await user.click(serviceKebab());

      await screen.findByText("Restart service");
      expect(screen.queryByText("Start service")).not.toBeInTheDocument();
    });

    it.each(["paused", "restarting", "dead"])(
      "does not offer 'Start service' for state:%s — docker compose start errors on it",
      async (state) => {
        dockByProject[1] = [dockerControl({ docker: { ...dockerControl().docker, state } })];
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const user = userEvent.setup();
        await screen.findByText("web");
        await user.click(serviceKebab());

        await screen.findByText("Restart service");
        expect(screen.queryByText("Start service")).not.toBeInTheDocument();
      },
    );

    it("a failed service action shows a transient error status instead of silently no-op'ing", async () => {
      dockByProject[1] = [dockerControl()];
      serviceActionResult = { success: false };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(serviceKebab());
      await user.click(await screen.findByText("Restart service"));

      const status = await screen.findByText("Restart failed");
      expect(status).toHaveClass("dock-monitor-check-status", "error");
    });

    it("stack Restart/Apply fire immediately and Stop stack requires arming", async () => {
      dockByProject[1] = [dockerControl()];
      stackActionByProject[1] = {
        sessionId: 44,
        control: { id: "docker-restart:sanctuary", title: "Restart sanctuary", source: "docker" },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(stackKebab());
      await user.click(await screen.findByText("Restart stack"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/restart",
          expect.objectContaining({ method: "POST" }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();

      await user.click(stackKebab());
      await user.click(await screen.findByText("Apply config"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/apply",
          expect.objectContaining({ method: "POST" }),
        );
      });

      await user.click(stackKebab());
      await user.click(await screen.findByText("Stop stack"));
      expect(fetchMock).not.toHaveBeenCalledWith(
        "/api/projects/1/docker/stack/stop",
        expect.anything(),
      );
      await user.click(await screen.findByText("Click again — stops the whole stack"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/stop",
          expect.objectContaining({ method: "POST" }),
        );
      });
    });

    it("a reused stack action (another one already running on this stack) surfaces a status message instead of adding a mismatched ephemeral row", async () => {
      // Issue #73 follow-up plan (5a), Hermes review — `reused: true` means
      // the backend refused to start a second concurrent operation on this
      // stack. `result.control` here would describe THIS click's action
      // (restart), not whatever's actually running, so adding it as an
      // ephemeral would render a row that never matches any live session
      // (command mismatch) and vanish again next render.
      dockByProject[1] = [dockerControl()];
      stackActionByProject[1] = {
        sessionId: 44,
        control: { id: "docker-restart:sanctuary", title: "Restart sanctuary", source: "docker" },
        reused: true,
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await user.click(stackKebab());
      await user.click(await screen.findByText("Restart stack"));

      expect(await screen.findByText("Already running another stack action")).toBeInTheDocument();
      // No mismatched ephemeral row, and no wasted refresh — the early
      // return skips both.
      expect(screen.queryByText("Restart sanctuary")).not.toBeInTheDocument();
      expect(refreshSessions).not.toHaveBeenCalled();
    });

    it("a manual dock.json control (no `docker` field) never renders a kebab or a stack header", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("Dev server");
      expect(document.querySelector(".kebab-trigger-btn")).not.toBeInTheDocument();
      expect(document.querySelector(".dock-stack-header")).not.toBeInTheDocument();
    });

    it("two compose projects in one column each get their own stack header, acting on their own stack", async () => {
      // Mirrors a real setup this repo's own dock plan calls out: a project
      // with a dev compose file (project name X) and a prod one (project
      // name Y) both discovered in the same column at once.
      const web = dockerControl();
      const api = dockerControl({
        id: "docker:pocket-dev:api",
        title: "api",
        docker: { ...dockerControl().docker, composeProject: "pocket-dev", service: "api" },
      });
      dockByProject[1] = [web, api];
      stackActionByProject[1] = {
        sessionId: 50,
        control: { id: "docker-restart:sanctuary", title: "Restart sanctuary", source: "docker" },
      };
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await screen.findByText("api");
      // Sorted by compose project name (dockHelpers.ts's groupDockerControls).
      const headers = document.querySelectorAll(".dock-stack-header-label");
      expect(Array.from(headers).map((h) => h.textContent)).toEqual(["pocket-dev", "sanctuary"]);

      const stackHeaders = document.querySelectorAll(".dock-stack-header .kebab-trigger-btn");
      expect(stackHeaders).toHaveLength(2);
      // The SECOND header is "sanctuary" (alphabetically after "pocket-dev")
      // — fire its Restart stack and confirm the request carries THAT
      // stack's own controlId, not the other group's.
      await user.click(stackHeaders[1]);
      await user.click(await screen.findByText("Restart stack"));
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/restart",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ controlId: "docker:sanctuary:web" }),
          }),
        );
      });
    });

    it("a hoisted stack action's outcome reports on ITS OWN group's stack header, not the other group's or any service row", async () => {
      // Guards the statusKey override Dock.tsx's handleStackAction/
      // handlePullAndRestart/handleRebuildAndRestart all take: without it,
      // a hoisted action's transient message would key off the
      // REPRESENTATIVE service's own control.id (like the old per-row
      // handlers did) and surface on that arbitrary row instead of the
      // group header the button that was actually clicked lives on.
      const web = dockerControl();
      const api = dockerControl({
        id: "docker:pocket-dev:api",
        title: "api",
        docker: { ...dockerControl().docker, composeProject: "pocket-dev", service: "api" },
      });
      dockByProject[1] = [web, api];
      stackActionByProject[1] = {
        sessionId: 55,
        control: {
          id: "docker-apply:sanctuary",
          title: "Apply config sanctuary",
          source: "docker",
        },
        willRecreate: true,
      };
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        refreshSessions: vi.fn().mockResolvedValue(undefined),
      });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await screen.findByText("api");
      const groups = document.querySelectorAll(".dock-stack-group");
      expect(groups).toHaveLength(2);
      // Sorted by compose project name: pocket-dev first, sanctuary second.
      const [pocketDevGroup, sanctuaryGroup] = Array.from(groups);
      expect(sanctuaryGroup.querySelector(".dock-stack-header-label")?.textContent).toBe(
        "sanctuary",
      );

      await user.click(sanctuaryGroup.querySelector(".kebab-trigger-btn")!);
      await user.click(await screen.findByText("Apply config"));

      const status = await screen.findByText("Applying — will recreate");
      // Lands inside sanctuary's own stack header...
      expect(sanctuaryGroup.contains(status)).toBe(true);
      // ...not in the OTHER group's header...
      expect(pocketDevGroup.contains(status)).toBe(false);
      // ...and not on either service's own row (checkStatusById[control.id],
      // the per-row mechanism this one is deliberately NOT using).
      expect(status.closest(".dock-monitor-header")).toBeNull();
    });

    it("a mixed stack (one registry-image service, one build-only) offers BOTH Pull and Rebuild in one stack menu, each hitting the correct service", async () => {
      const registryService = dockerControl({
        id: "docker:sanctuary:web",
        title: "web",
        docker: { ...dockerControl().docker, service: "web", buildOnly: false },
      });
      const buildOnlyService = dockerControl({
        id: "docker:sanctuary:api",
        title: "api",
        docker: { ...dockerControl().docker, service: "api", buildOnly: true },
      });
      dockByProject[1] = [registryService, buildOnlyService];
      updateByProject[1] = {
        sessionId: 51,
        control: { id: "docker-update:sanctuary", title: "Update sanctuary", source: "docker" },
      };
      rebuildByProject[1] = {
        sessionId: 52,
        control: { id: "docker-rebuild:sanctuary", title: "Rebuild sanctuary", source: "docker" },
      };
      const refreshSessions = vi.fn().mockResolvedValue(undefined);
      useDashboardStore.setState({ projects: [PROJECT], sessions: [], refreshSessions });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      await screen.findByText("web");
      await screen.findByText("api");
      await user.click(stackKebab());

      // Both present in the SAME menu — not an either/or like the old
      // per-row menu.
      expect(await screen.findByText("Pull & restart stack")).toBeInTheDocument();
      expect(screen.getByText("Rebuild & restart stack")).toBeInTheDocument();

      await user.click(screen.getByText("Pull & restart stack"));
      await user.click(await screen.findByText("Click again — restarts the whole stack"));
      // The exact 400 this test guards against: /docker/update rejects a
      // build-only controlId (src/routes/projects.ts), so the request MUST
      // carry the registry-image service's id, not the build-only one's.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/update",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ controlId: "docker:sanctuary:web" }),
          }),
        );
      });
      expect(refreshSessions).toHaveBeenCalled();

      await user.click(stackKebab());
      await user.click(await screen.findByText("Rebuild & restart stack"));
      await user.click(
        await screen.findByText("Click again — rebuilds and restarts the whole stack"),
      );
      // Mirror-image guard: /docker/stack/rebuild rejects a NON-build-only
      // controlId, so this one must carry the build-only service's id.
      await waitFor(() => {
        expect(fetchMock).toHaveBeenCalledWith(
          "/api/projects/1/docker/stack/rebuild",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({ controlId: "docker:sanctuary:api" }),
          }),
        );
      });
    });

    describe("issue #1240 — an orphaned dock session (control dropped out of discovery)", () => {
      it("a docker-logs:<containerName> session with no matching control renders as a marked-orphaned, standalone row", async () => {
        dockByProject[1] = []; // no discovered services at all — the whole stack is gone
        const orphanSession = makeSession({
          id: 99,
          kind: "dock",
          name: "docker-logs:ghost-web-1",
          command:
            "docker compose -p 'ghost' --project-directory '/x/ghost' logs -f --tail=200 'web'",
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const nameEl = await screen.findByText("ghost-web-1");
        const row = nameEl.closest(".dock-monitor") as HTMLElement;
        expect(row).toHaveClass("dock-monitor--orphaned");
        expect(row).toHaveAttribute(
          "aria-label",
          expect.stringContaining("orphaned, no matching service"),
        );
        // No discovered service behind it — not inside a stack group.
        expect(row.closest(".dock-stack-group")).toBeNull();
      });

      it("ordering: a control still inside its RECREATE_GRACE_MS hold window renders ONLY as its held row, never also as a duplicate orphaned row", async () => {
        // This is the ordering the implementation is required to get right —
        // orphan detection must run AFTER holdVanishedDockerControls' own
        // merge, so a control still within its hold window (already present
        // in the rendered-controls list via the hold, matched by the same
        // dockerSessionIdentity) is correctly excluded from the orphan set.
        // Getting this backwards would render the same session as BOTH a
        // held row (recreating…) AND a separate orphaned row in one commit.
        const T0 = 1_700_000_000_000;
        const dateSpy = vi.spyOn(Date, "now").mockReturnValue(T0);
        try {
          dockByProject[1] = [dockerControl()];
          const runningSession = makeSession({
            id: 42,
            kind: "dock",
            name: "docker-logs:sanctuary-web",
            command: dockerControl().command,
            status: "active",
          });
          useDashboardStore.setState({
            projects: [PROJECT],
            sessions: [runningSession],
            sessionsLoaded: true,
          });
          render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
          await screen.findByText("web");

          // The service drops out of discovery — still within the grace
          // window, so it must be HELD, not orphaned.
          dockByProject[1] = [];
          useDashboardStore.getState().bumpDockConfigRefreshTrigger();
          await screen.findByText("recreating…");

          const monitors = document.querySelectorAll(".dock-monitor");
          expect(monitors.length).toBe(1);
          expect(monitors[0]).not.toHaveClass("dock-monitor--orphaned");
          expect(document.querySelector(".dock-monitor--orphaned")).toBeNull();
        } finally {
          dateSpy.mockRestore();
        }
      });

      it("selecting an orphan row shows its log in the log pane, and stopping its stream calls deleteSession — the row then disappears on the next poll", async () => {
        dockByProject[1] = [];
        const orphanSession = makeSession({
          id: 77,
          kind: "dock",
          name: "docker-logs:ghost-web-1",
          command:
            "docker compose -p 'ghost' --project-directory '/x/ghost' logs -f --tail=200 'web'",
          status: "active",
        });
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
          deleteSession,
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const row = await screen.findByText("ghost-web-1");
        await user.click(row);
        await waitFor(() => {
          expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "77");
        });

        // No `.docker` field at all on a synthetic orphan control, so the
        // stream-toggle tag reads "on"/"off" (not "logs on"/"logs off" —
        // DockMonitor.tsx's own label logic keys off `control.docker`).
        await user.click(screen.getByText("on"));
        expect(deleteSession).toHaveBeenCalledWith(77);

        // Simulate the next poll observing the session actually gone.
        useDashboardStore.setState({ sessions: [] });
        await waitFor(() => expect(screen.queryByText("ghost-web-1")).not.toBeInTheDocument());
      });

      it("attaches an orphan under its former stack's group when that group still has other live services", async () => {
        dockByProject[1] = [dockerControl()]; // "web" service still live, group "sanctuary"
        const orphanSession = makeSession({
          id: 55,
          kind: "dock",
          // compose's own deterministic <project>-<service>-<replica> naming
          // — "sanctuary-worker-1" parses back to project "sanctuary".
          name: "docker-logs:sanctuary-worker-1",
          command: "docker compose -p 'sanctuary' logs -f --tail=200 'worker'",
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        const orphanName = await screen.findByText("sanctuary-worker-1");
        const group = document.querySelector(".dock-stack-group") as HTMLElement;
        expect(group.contains(orphanName)).toBe(true);
        expect(orphanName.closest(".dock-monitor")).toHaveClass("dock-monitor--orphaned");
      });

      it("renders standalone when the whole former stack is gone, not just this one service", async () => {
        dockByProject[1] = []; // no live services in ANY compose project
        const orphanSession = makeSession({
          id: 56,
          kind: "dock",
          name: "docker-logs:sanctuary-web-1",
          command: "docker compose -p 'sanctuary' logs -f --tail=200 'web'",
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const orphanName = await screen.findByText("sanctuary-web-1");
        expect(orphanName.closest(".dock-stack-group")).toBeNull();
      });

      it("renders standalone when the container name doesn't match compose's <project>-<service>-<replica> convention (a container_name: override)", async () => {
        // dockerControl()'s own "sanctuary" group is still live, but the
        // orphan's container name doesn't parse against the naming
        // convention at all (e.g. an explicit `container_name:` override in
        // the compose file) — composeProjectFromContainerName returns null,
        // so this must render standalone rather than guessing a group.
        dockByProject[1] = [dockerControl()];
        const orphanSession = makeSession({
          id: 57,
          kind: "dock",
          name: "docker-logs:my-custom-name",
          command: "docker compose -p 'sanctuary' logs -f --tail=200 'worker'",
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        await screen.findByText("web");
        const orphanName = await screen.findByText("my-custom-name");
        expect(orphanName.closest(".dock-stack-group")).toBeNull();
      });

      it("does NOT mark a reconstructed live stack-action row (docker-stack:<composeProject>) as orphaned", async () => {
        // Regression guard for the `!control.docker` gating mistake this
        // issue's own implementation notes warn about: `reconstructedEphemeralControls`
        // (Dock.tsx) also builds a `source: "docker"` control with no
        // `.docker` field, for a completely different reason (a live stack
        // action surviving a workspace switch, not an orphaned log
        // session) — its id is always `docker-stack:<composeProject>`, a
        // different, non-overlapping prefix from `docker-logs:`.
        dockByProject[1] = [];
        const rebuildCommand =
          "docker compose -p 'sanctuary' build --pull && docker compose -p 'sanctuary' up -d";
        const rebuildSession = makeSession({
          id: 88,
          kind: "dock",
          name: "docker-stack:sanctuary",
          command: rebuildCommand,
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [rebuildSession],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const reconstructedRow = await screen.findByText("Stack action running — sanctuary");
        expect(reconstructedRow.closest(".dock-monitor")).not.toHaveClass("dock-monitor--orphaned");
      });

      it("code-review — does NOT mark a plain .crs/dock.json control as orphaned even when its id is crafted to match a docker-logs: session name (the documented override escape hatch)", async () => {
        // docs/dock.md documents a dock.json control's own `id` colliding
        // with a discovered control's id as a supported override escape
        // hatch, and dockerSessionIdentity's own "never collides" test
        // (dockHelpers.test.ts) crafts exactly this shape: a plain config
        // control (source undefined, no `.docker`) whose `id` happens to
        // equal a real `docker-logs:<containerName>` string. This control
        // is ordinary and working — DockMonitor must not flag it as
        // orphaned just because its `id` happens to start with
        // "docker-logs:"; only a control whose `source` is also "docker"
        // (the shape Dock.tsx's own synthetic orphan controls always carry)
        // should ever get the orphaned marker.
        dockByProject[1] = [
          { id: "docker-logs:sanctuary-web", title: "My override", command: "npm run dev" },
        ];
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [],
          sessionsLoaded: true,
        });
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const row = await screen.findByText("My override");
        expect(row.closest(".dock-monitor")).not.toHaveClass("dock-monitor--orphaned");
      });

      it("code-review — a SELECTED orphaned row still carries the selected class alongside orphaned, for CSS's compound override to key off", async () => {
        dockByProject[1] = [];
        const orphanSession = makeSession({
          id: 66,
          kind: "dock",
          name: "docker-logs:ghost-web-1",
          command: "docker compose -p 'ghost' logs -f --tail=200 'web'",
          status: "active",
        });
        useDashboardStore.setState({
          projects: [PROJECT],
          sessions: [orphanSession],
          sessionsLoaded: true,
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

        const row = await screen.findByText("ghost-web-1");
        await user.click(row);

        const monitorRow = row.closest(".dock-monitor") as HTMLElement;
        await waitFor(() => expect(monitorRow).toHaveClass("dock-monitor--selected"));
        expect(monitorRow).toHaveClass("dock-monitor--orphaned");
      });
    });
  });

  // Helpers for interacting with CustomSelect in tests.
  async function selectWorktreeOption(
    u: ReturnType<typeof userEvent.setup>,
    c: HTMLElement,
    value: string,
  ) {
    const wrapper = c.querySelector(".dock-monitor-worktree-select") as HTMLElement;
    await u.click(wrapper.querySelector(".custom-select-trigger")!);
    await waitFor(() => {
      expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
    });
    const items = document.querySelectorAll(".custom-select-item");
    const target = Array.from(items).find((el) => el.getAttribute("data-value") === value);
    if (target) await u.click(target);
  }

  function getSelectedWorktreeValue(c: HTMLElement): string | null {
    const wrapper = c.querySelector(".dock-monitor-worktree-select") as HTMLElement;
    return (
      wrapper.querySelector(".custom-select-trigger")?.getAttribute("data-selected-value") ?? null
    );
  }

  function getWorktreeOptionValues(): string[] {
    const items = document.querySelectorAll(".custom-select-item");
    return Array.from(items).map((el) => el.getAttribute("data-value")!);
  }

  describe("worktree selector", () => {
    const MAIN_WORKTREE: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [{ path: "/home/x/mullion", branch: "main", isMain: true }],
      remoteBranches: [],
    };

    const MULTI_WORKTREE: GitBranchesResult = {
      branches: [
        { name: "main", isCurrent: false },
        { name: "feature-x", isCurrent: true },
      ],
      worktrees: [
        { path: "/home/x/mullion", branch: "main", isMain: true },
        {
          path: "/home/x/mullion/.mullion-worktrees/feature-x",
          branch: "feature-x",
          isMain: false,
        },
      ],
      remoteBranches: [],
    };

    function setupStore(overrides: Partial<Parameters<typeof useDashboardStore.setState>[0]> = {}) {
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession: vi.fn().mockResolvedValue({}),
        deleteSession: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      });
    }

    it("shows no worktree selector when gitBranchesByProject is undefined (not yet fetched)", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: {} });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      expect(container.querySelector(".dock-monitor-worktree-select")).not.toBeInTheDocument();
    });

    it("shows no worktree selector when project has only the main checkout", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MAIN_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      expect(container.querySelector(".dock-monitor-worktree-select")).not.toBeInTheDocument();
    });

    it("shows a worktree selector when project has multiple worktrees", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      expect(container.querySelector(".dock-monitor-worktree-select")).toBeInTheDocument();
    });

    it("lists all worktree branches in the selector", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
      (wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement).focus();
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
      });
      const options = getWorktreeOptionValues();
      expect(options).toContain("/home/x/mullion");
      expect(options).toContain("/home/x/mullion/.mullion-worktrees/feature-x");
    });

    it("defaults to the main checkout worktree", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      expect(getSelectedWorktreeValue(container)).toBe("/home/x/mullion");
    });

    it("passes the default worktree path as cwd when toggling on (first use)", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      setupStore({ createSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);

      const header = (await screen.findByText("Dev server")).closest(".dock-monitor-header")!;
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("passes the selected worktree path as cwd when toggling on", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      setupStore({ createSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      const header = screen.getByText("Dev server").closest(".dock-monitor-header")!;
      await user.click(header);

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
      });
    });

    it("shows the worktree selector even when running, reflecting the session's cwd", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        sessions: [runningSession],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });

      // The select is still visible when running
      await waitFor(() => {
        expect(container.querySelector(".dock-monitor-worktree-select")).toBeInTheDocument();
      });
      // And it reflects the running session's worktree path
      expect(getSelectedWorktreeValue(container)).toBe(
        "/home/x/mullion/.mullion-worktrees/feature-x",
      );
      expect(screen.getByText("on")).toBeInTheDocument();
    });

    it("kills and restarts the session when worktree selection changes while running", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );

      await screen.findByText("Dev server");

      const runningSession: Session = makeSession({
        id: 99,
        command: "npm run dev",
        cwd: "/home/x/mullion",
        kind: "dock",
        activity: "idle",
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
      });
      useDashboardStore.setState({
        sessions: [runningSession],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });

      // Wait for the component to re-render with the running session
      await waitFor(() => {
        expect(screen.getByText("on")).toBeInTheDocument();
      });

      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      expect(deleteSession).toHaveBeenCalledWith(99);
      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
        kind: "dock",
      });
    });

    function makeRunningDockSession(overrides: Partial<Session> = {}): Session {
      return {
        id: 99,
        projectId: 1,
        parentSessionId: null,
        name: null,
        nameLocked: false,
        command: "npm run dev",
        cwd: "/home/x/mullion",
        env: null,
        liveCwd: null,
        previewBranch: null,
        kind: "dock",
        status: "active",
        createdAt: "2026-01-01T00:00:00.000Z",
        lastAttachedAt: null,
        alive: true,
        subscriberCount: 0,
        activity: "idle",
        lastActivityAt: null,
        attention: false,
        attentionAt: null,
        lastTitle: null,
        gateState: "idle",
        gates: [],
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        endedReason: null,
        liveBranch: null,
        exitCode: null,
        attentionKind: null,
        errorDetail: null,
        lastAssistantMessage: null,
        compactState: "idle",
        subagentCount: 0,
        subagents: [],
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        stateRestored: true,
        staleHooks: false,
        restoredVersion: null,
        sessionStatus: "idle",
        sessionStatusSeverity: "dormant",
        sessionStatusDetail: null,
        hookEmits: [],
        pendingDevServerPort: null,
        outstandingBackgroundTasks: [],
        sessionStatusAttentionRequired: false,
        ...overrides,
      };
    }

    // U5 regression — the original bug: Dock.tsx's switch handler decided
    // whether to relaunch by re-reading `sessions` off the store AFTER
    // awaiting `deleteSession`, but the REAL `store.deleteSession`
    // (store.ts) itself awaits `refreshSessions()` before resolving — so by
    // the time that check ran, the just-deleted row already read "killed"
    // and the relaunch branch was unreachable. Every OTHER test in this
    // file mocks `deleteSession` as a bare `vi.fn().mockResolvedValue(...)`
    // that never touches `sessions` at all, which can't catch this — it
    // would pass identically whether the fix was in place or not. This one
    // mocks `deleteSession` to actually mutate `sessions` to "killed" the
    // same way the real store action does, so it fails against the
    // original code and passes against the fix.
    it("U5 — relaunches at the new worktree even though the just-deleted row already reads 'killed' by the time the check runs", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn(async (id: number) => {
        useDashboardStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, status: "killed" as const } : sess,
          ),
        }));
      });
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: MULTI_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");

      await waitFor(() => expect(deleteSession).toHaveBeenCalledWith(99));
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          cwd: "/home/x/mullion/.mullion-worktrees/feature-x",
          kind: "dock",
        }),
      );
    });

    // U5 nuance — the ORIGINAL code's live-state re-check existed to avoid
    // relaunching a monitor the user manually toggled off during the async
    // delete-then-relaunch window. The fix preserves that with a
    // toggleGenRef bumped only by an explicit header click, not by
    // re-deriving from session status. This proves the preserved intent:
    // clicking the header (which, with confirmBeforeKill off, kills
    // immediately) WHILE the worktree-switch's own delete is in flight must
    // suppress that switch's pending relaunch.
    it("U5 nuance — a manual header click during the in-flight switch suppresses the pending relaunch", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      let deleteCalls = 0;
      let resolveSwitchDelete: (() => void) | undefined;
      const markKilled = (id: number) =>
        useDashboardStore.setState((s) => ({
          sessions: s.sessions.map((sess) =>
            sess.id === id ? { ...sess, status: "killed" as const } : sess,
          ),
        }));
      const deleteSession = vi.fn((id: number) => {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          // The switch's own delete — deliberately stays pending (not
          // mutating `sessions` yet) until resolveSwitchDelete() fires
          // below, the same "sessions still reads active mid-flight" window
          // the real store.deleteSession has during its own network round
          // trip, before its refreshSessions() call lands.
          return new Promise<void>((resolve) => {
            resolveSwitchDelete = () => {
              markKilled(id);
              resolve();
            };
          });
        }
        // The header's own manual kill (this test's second deleteSession
        // call) — resolves immediately, same as this file's other mocks.
        markKilled(id);
        return Promise.resolve();
      });
      setupStore({
        createSession,
        deleteSession,
        gitBranchesByProject: { 1: MULTI_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: MULTI_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      // Kicks off the switch's own deleteSession call, which hangs (still
      // "on" in the UI) until resolveSwitchDelete() fires below.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));
      expect(screen.getByText("on")).toBeInTheDocument();

      // The user manually clicks the stream-toggle tag (still reads "on" —
      // the switch's own delete hasn't resolved yet) while that switch is
      // in flight — confirmBeforeKill is off, so this kills immediately.
      // Dock master-detail rework — killing moved from the row body to this
      // tag; see DockMonitor.tsx's own header comment on the split.
      await user.click(screen.getByText("on"));
      expect(deleteSession).toHaveBeenCalledTimes(2);

      // Now let the switch's own delete resolve.
      resolveSwitchDelete?.();
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));

      // Neither the manual click (a kill, not a start) nor the switch's own
      // now-superseded relaunch should ever call createSession.
      await new Promise((r) => setTimeout(r, 0));
      expect(createSession).not.toHaveBeenCalled();
    });

    describe("U8 — confirm before killing a running dock monitor from its header", () => {
      it("arms on the first click instead of killing immediately, then kills on a second click", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockResolvedValue({});
        const deleteSession = vi.fn().mockResolvedValue(undefined);
        setupStore({
          createSession,
          deleteSession,
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: true },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        await screen.findByText("Dev server");

        useDashboardStore.setState({ sessions: [makeRunningDockSession()] });
        await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

        // Dock master-detail rework — killing (and arming) is the trailing
        // tag's own job now, not the row body's.
        await user.click(screen.getByText("on"));

        // Armed, not killed — the tag flips to "confirm?" and deleteSession
        // must not have fired yet.
        const confirmTag = await screen.findByText("confirm?");
        expect(deleteSession).not.toHaveBeenCalled();

        await user.click(confirmTag);

        expect(deleteSession).toHaveBeenCalledWith(99);
      });

      it("start (nothing running) always fires immediately regardless of confirmBeforeKill", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockResolvedValue({});
        setupStore({
          createSession,
          // Explicit, not inherited — earlier tests in this describe block
          // set gitBranchesByProject on the shared store singleton, and
          // setupStore's own defaults don't reset it, so leaving this out
          // would non-deterministically resolve a mainCheckoutPath from
          // whichever test happened to run before this one.
          gitBranchesByProject: {},
          settings: {
            ...DEFAULT_SETTINGS,
            sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: true },
          },
        });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        const header = await screen.findByText("Dev server");

        await user.click(header);

        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          kind: "dock",
        });
      });

      // Hermes review round 1 — the header's start affordance used to
      // discard launchForValue's promise with a bare `void`, so a failed
      // createSession (dead remote host, a bad worktree path, ...) was an
      // unhandled rejection with nothing shown — the exact P9 silent-
      // failure class this PR fixes everywhere else.
      it("surfaces an inline error when starting a monitor fails, instead of an unhandled rejection", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        const createSession = vi.fn().mockRejectedValue(new Error("Host is unreachable"));
        setupStore({ createSession, gitBranchesByProject: {} });
        const user = userEvent.setup();
        render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
        const header = await screen.findByText("Dev server");

        await user.click(header);

        expect(await screen.findByText("Failed to start — try again")).toBeInTheDocument();
      });
    });

    // Hermes review round 1 (suggestion) — the toggleGenRef generation
    // counter previously only advanced on an explicit header click, so two
    // rapid worktree switches on the same control could race: each starts
    // its own delete-then-relaunch IIFE, and if both deletes resolved, the
    // FIRST switch's relaunch could still fire (at its own, now-stale
    // path) after the SECOND switch had already moved the select on to a
    // newer one. The fix bumps the counter at the START of every switch
    // too, not just on a manual header toggle.
    it("Hermes review round 1 — a second, newer worktree switch invalidates a still in-flight first switch's relaunch", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const resolvers: Array<() => void> = [];
      const deleteSession = vi.fn((id: number) => {
        return new Promise<void>((resolve) => {
          resolvers.push(() => {
            useDashboardStore.setState((s) => ({
              sessions: s.sessions.map((sess) =>
                sess.id === id ? { ...sess, status: "killed" as const } : sess,
              ),
            }));
            resolve();
          });
        });
      });
      const THREE_WORKTREE: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: false },
          { name: "feature-x", isCurrent: false },
          { name: "feature-y", isCurrent: true },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-x",
            branch: "feature-x",
            isMain: false,
          },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-y",
            branch: "feature-y",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      setupStore({ createSession, deleteSession, gitBranchesByProject: { 1: THREE_WORKTREE } });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");

      useDashboardStore.setState({
        sessions: [makeRunningDockSession()],
        gitBranchesByProject: { 1: THREE_WORKTREE },
      });
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      // First switch — its own deleteSession call stays pending.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-x");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(1));

      // Before the first switch's delete resolves, a second, newer switch
      // starts — its own deleteSession call also stays pending. Both
      // target the same still-running session id (99): the first switch
      // hasn't mutated `sessions` yet (its own delete is still in flight),
      // so the select still reads this session as running.
      await selectWorktreeOption(user, container, "/home/x/mullion/.mullion-worktrees/feature-y");
      await waitFor(() => expect(deleteSession).toHaveBeenCalledTimes(2));

      // Resolve the FIRST switch's delete now — its relaunch must be
      // suppressed (superseded by the second switch), not fire at the
      // stale feature-x path.
      resolvers[0]!();
      await waitFor(() => expect(createSession).not.toHaveBeenCalled());

      // Resolve the SECOND (newer) switch's delete — its relaunch, at
      // feature-y, is the only one that should ever fire.
      resolvers[1]!();
      await waitFor(() =>
        expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
          cwd: "/home/x/mullion/.mullion-worktrees/feature-y",
          kind: "dock",
        }),
      );
      expect(createSession).toHaveBeenCalledTimes(1);
    });

    // PR #341 review: preview worktrees are checked out with a detached
    // HEAD (git-worktree.ts's checkoutBranchWorktree), so listWorktrees
    // reports `branch: null` for one — it must be filtered out of the
    // worktree options (else it'd show up a second time, labeled by its raw
    // path) while its "<branch> (preview)" option stays available. A
    // running preview session's `cwd` is therefore never an option value,
    // so the select must resolve through the session's `previewBranch`
    // field instead — with a non-blank fallback when that's null.
    describe("preview worktrees (detached HEAD)", () => {
      const PREVIEW_WORKTREE_PATH =
        "/home/x/mullion/.mullion-worktrees/dock-preview-feature-y-abc123";

      const WITH_PREVIEW: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: true },
          { name: "feature-y", isCurrent: false },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          { path: PREVIEW_WORKTREE_PATH, branch: null, isMain: false },
        ],
        remoteBranches: [],
      };

      function makeRunningSession(overrides: Partial<Session>): Session {
        return {
          id: 99,
          projectId: 1,
          parentSessionId: null,
          name: null,
          nameLocked: false,
          command: "npm run dev",
          cwd: null,
          env: null,
          liveCwd: null,
          previewBranch: null,
          kind: "dock",
          status: "active",
          createdAt: "2026-01-01T00:00:00.000Z",
          lastAttachedAt: null,
          alive: true,
          subscriberCount: 0,
          activity: "idle",
          lastActivityAt: null,
          attention: false,
          attentionAt: null,
          lastTitle: null,
          gateState: "idle",
          gates: [],
          gatePrompt: null,
          promoteState: "idle",
          promoteSummary: null,
          promoteSuggestedBaseRef: null,
          permissionState: "idle",
          planState: "idle",
          errorState: "idle",
          endedReason: null,
          liveBranch: null,
          exitCode: null,
          attentionKind: null,
          errorDetail: null,
          lastAssistantMessage: null,
          compactState: "idle",
          subagentCount: 0,
          subagents: [],
          elicitationState: "idle",
          elicitationServer: null,
          lastTurnEndedAt: null,
          sessionStatus: "idle",
          sessionStatusSeverity: "dormant",
          sessionStatusDetail: null,
          hookEmits: [],
          pendingDevServerPort: null,
          outstandingBackgroundTasks: [],
          sessionStatusAttentionRequired: false,
          stateRestored: true,
          staleHooks: false,
          restoredVersion: null,
          ...overrides,
        };
      }

      it("excludes the preview worktree's raw path from the select options, keeping the branch option", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );

        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        (wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement).focus();
        await user.keyboard("{ArrowDown}");
        await waitFor(() => {
          expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
        });
        const options = getWorktreeOptionValues();

        expect(options).toContain("/home/x/mullion");
        expect(options).toContain("branch:feature-y");
        expect(options).not.toContain(PREVIEW_WORKTREE_PATH);
      });

      it("resolves a running preview session to its branch option via previewBranch", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        useDashboardStore.setState({
          sessions: [
            makeRunningSession({ cwd: PREVIEW_WORKTREE_PATH, previewBranch: "feature-y" }),
          ],
          gitBranchesByProject: { 1: WITH_PREVIEW },
        });

        await waitFor(() => {
          expect(getSelectedWorktreeValue(container)).toBe("branch:feature-y");
        });
      });

      it("falls back to the main checkout, never blank, when a running preview session has no previewBranch (server restart)", async () => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
        setupStore({ gitBranchesByProject: { 1: WITH_PREVIEW } });
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        useDashboardStore.setState({
          sessions: [makeRunningSession({ cwd: PREVIEW_WORKTREE_PATH, previewBranch: null })],
          gitBranchesByProject: { 1: WITH_PREVIEW },
        });

        await waitFor(() => {
          expect(getSelectedWorktreeValue(container)).toBe("/home/x/mullion");
        });
      });
    });

    describe("keyboard navigation", () => {
      beforeEach(() => {
        dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      });

      it("opens the menu via ArrowDown and focuses the first option", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");

        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();
        expect(trigger.getAttribute("aria-expanded")).toBe("true");
        expect(document.querySelector(".custom-select-item.focused")).toBeInTheDocument();
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-0");
      });

      it("selects the focused option via Enter, updating the selected value", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();

        // ArrowDown twice navigates from main (index 0) to feature-x (index 1)
        await user.keyboard("{ArrowDown}{ArrowDown}");
        await user.keyboard("{Enter}");

        // Menu closes and the selected value updates
        expect(trigger.getAttribute("data-selected-value")).toBe(
          "/home/x/mullion/.mullion-worktrees/feature-x",
        );
      });

      it("closes the menu via Escape", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();

        await user.keyboard("{Escape}");
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      });

      it("closes the menu via Tab", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");
        expect(document.querySelector(".custom-select-menu")).toBeInTheDocument();

        await user.keyboard("{Tab}");
        expect(trigger.getAttribute("aria-expanded")).toBe("false");
      });

      it("navigates up and down through options via arrow keys", async () => {
        setupStore({ gitBranchesByProject: { 1: MULTI_WORKTREE } });
        const user = userEvent.setup();
        const { container } = render(
          <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
        );
        await screen.findByText("Dev server");

        const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
        const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
        trigger.focus();
        await user.keyboard("{ArrowDown}");

        // Down moves from main (0) to feature-x (1)
        await user.keyboard("{ArrowDown}");
        let focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-1");

        // Up moves back to main (0)
        await user.keyboard("{ArrowUp}");
        focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-0");

        // Up wraps around to last option
        await user.keyboard("{ArrowUp}");
        focused = document.querySelectorAll(".custom-select-item.focused");
        expect(focused).toHaveLength(1);
        expect(trigger.getAttribute("aria-activedescendant")).toBe("custom-select-opt-1");
      });
    });
  });

  // P10 — the monitor header was a bare <div onClick> with no keyboard
  // support, on top of U8's separate "one unconfirmed click kills a running
  // dev server" finding. Same role="button"/tabIndex/Enter-Space pattern as
  // Sidebar.tsx's SessionRow/ProjectHeader.
  describe("P10 — keyboard accessibility", () => {
    // The single-worktree shape `resolveSelectedValue`'s `mainCheckout`
    // needs to resolve `control.cwd`-less launches against the project's
    // own checkout path — without it, `gitBranchesByProject` has no entry
    // for this project (the "not yet fetched" state) and the launched
    // session's cwd falls back to `control.cwd` (unset for these fixtures),
    // i.e. no `cwd` key at all. Explicit here (rather than relying on the
    // "worktree selector" describe block's own MULTI_WORKTREE/MAIN_WORKTREE
    // consts, out of scope from this describe block) since a previous
    // version of this suite let this leak in from whichever earlier test
    // happened to run first — a real cross-test isolation bug resetStore()
    // (test/resetStore.ts) now catches instead of silently passing.
    const SINGLE_WORKTREE: GitBranchesResult = {
      branches: [{ name: "main", isCurrent: true }],
      worktrees: [{ path: "/home/x/mullion", branch: "main", isMain: true }],
      remoteBranches: [],
    };

    it("is a focusable role=button that starts a monitor on Enter", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        gitBranchesByProject: { 1: SINGLE_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");
      // Dock master-detail rework — role/tabIndex moved from
      // `.dock-monitor-header` up to `.dock-monitor` itself (DockMonitor.
      // tsx's own comment on why: a valid listbox needs `option` as a
      // direct child; this settled on plain `role="button"` instead, but
      // kept the relocation).
      const row = container.querySelector(".dock-monitor") as HTMLElement;
      expect(row).toHaveAttribute("role", "button");
      expect(row).toHaveAttribute("tabIndex", "0");

      row.focus();
      await user.keyboard("{Enter}");

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("starts a monitor on Space too", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [],
        createSession,
        deleteSession: vi.fn().mockResolvedValue(undefined),
        gitBranchesByProject: { 1: SINGLE_WORKTREE },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await screen.findByText("Dev server");
      const row = container.querySelector(".dock-monitor") as HTMLElement;

      row.focus();
      await user.keyboard(" ");

      expect(createSession).toHaveBeenCalledWith(1, "npm run dev", {
        cwd: "/home/x/mullion",
        kind: "dock",
      });
    });

    it("does not double-fire the header's own action when the worktree selector's own trigger is clicked", async () => {
      dockByProject[1] = [{ id: "dev", title: "Dev server", command: "npm run dev" }];
      const createSession = vi.fn().mockResolvedValue({});
      const deleteSession = vi.fn().mockResolvedValue(undefined);
      const MULTI: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: false },
          { name: "feature-x", isCurrent: true },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-x",
            branch: "feature-x",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [
          makeSession({
            id: 99,
            command: "npm run dev",
            cwd: "/home/x/mullion",
            kind: "dock",
            activity: "idle",
            sessionStatus: "idle",
            sessionStatusSeverity: "dormant",
          }),
        ],
        createSession,
        deleteSession,
        gitBranchesByProject: { 1: MULTI },
        settings: {
          ...DEFAULT_SETTINGS,
          sessions: { ...DEFAULT_SETTINGS.sessions, confirmBeforeKill: false },
        },
      });
      const user = userEvent.setup();
      const { container } = render(
        <Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />,
      );
      await waitFor(() => expect(screen.getByText("on")).toBeInTheDocument());

      const wrapper = container.querySelector(".dock-monitor-worktree-select") as HTMLElement;
      const trigger = wrapper.querySelector(".custom-select-trigger") as HTMLButtonElement;
      await user.click(trigger);

      // A click on the worktree picker's own trigger must not ALSO kill the
      // running monitor via the header's onClick.
      expect(deleteSession).not.toHaveBeenCalled();
    });

    it("Hermes review — a click on the worktree selector's own trigger does not ALSO select that row", async () => {
      // Two running monitors so adopt-on-empty (Dock.tsx) has something to
      // pick besides the one under test — with only one row, "did clicking
      // its own selector select it" is indistinguishable from "it was
      // already the sole adopted row." "a" sorts first alphabetically among
      // the discovered controls' own ids, so it's the one adopt-on-empty
      // picks.
      dockByProject[1] = [
        { id: "a", title: "A server", command: "npm run a" },
        { id: "b", title: "B server", command: "npm run b" },
      ];
      const MULTI: GitBranchesResult = {
        branches: [
          { name: "main", isCurrent: false },
          { name: "feature-x", isCurrent: true },
        ],
        worktrees: [
          { path: "/home/x/mullion", branch: "main", isMain: true },
          {
            path: "/home/x/mullion/.mullion-worktrees/feature-x",
            branch: "feature-x",
            isMain: false,
          },
        ],
        remoteBranches: [],
      };
      useDashboardStore.setState({
        projects: [PROJECT],
        sessions: [
          makeSession({ id: 10, command: "npm run a", kind: "dock" }),
          makeSession({ id: 20, command: "npm run b", kind: "dock" }),
        ],
        gitBranchesByProject: { 1: MULTI },
      });
      const user = userEvent.setup();
      render(<Dock workspaceProjectIds={[1]} onOpenGitHub={vi.fn()} onOpenBrowser={vi.fn()} />);
      await screen.findByText("A server");
      await screen.findByText("B server");
      await waitFor(() => {
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "10");
      });

      // Click "B server"'s own worktree-selector trigger — not its row body.
      const bRow = screen.getByText("B server").closest(".dock-monitor") as HTMLElement;
      const trigger = bRow.querySelector(".custom-select-trigger") as HTMLButtonElement;
      await user.click(trigger);

      // Still showing "A"'s session — the click didn't bubble into
      // selecting "B"'s row.
      expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-session-id", "10");
      expect(bRow).not.toHaveClass("dock-monitor--selected");
    });
  });
});

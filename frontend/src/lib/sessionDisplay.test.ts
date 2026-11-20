import { describe, expect, it } from "vitest";
import { makeProject, makeSession, makeTask } from "../test/fixtures.js";
import {
  buildSessionTitleContexts,
  isListedSession,
  selectSessionTitle,
  selectSessionTitleContexts,
  sessionDisplayTitle,
  sessionMatchesSearch,
  sessionPaneTitle,
  sessionTitleIsCommand,
} from "./sessionDisplay.js";

describe("sessionDisplayTitle", () => {
  it("prefers the locked name when nameLocked is true and name is set", () => {
    const session = makeSession({ nameLocked: true, name: "My Session", lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("My Session");
  });

  it("falls back to lastTitle when not name-locked", () => {
    const session = makeSession({ nameLocked: false, name: "launch name", lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("OSC title");
  });

  it("falls back to lastTitle when nameLocked is true but name is null", () => {
    const session = makeSession({ nameLocked: true, name: null, lastTitle: "OSC title" });
    expect(sessionDisplayTitle(session)).toBe("OSC title");
  });

  it("falls back to command when neither name nor lastTitle is set", () => {
    const session = makeSession({
      nameLocked: false,
      name: null,
      lastTitle: null,
      command: "npm run dev",
    });
    expect(sessionDisplayTitle(session)).toBe("npm run dev");
  });

  it("falls back to command when nameLocked is true but name is an empty string", () => {
    const session = makeSession({
      nameLocked: true,
      name: "",
      lastTitle: null,
      command: "npm run dev",
    });
    expect(sessionDisplayTitle(session)).toBe("npm run dev");
  });
});

describe("sessionMatchesSearch", () => {
  const project = makeProject({ name: "mullion-session-manager" });

  it("matches on the session's displayed title, case-insensitively", () => {
    const session = makeSession({ nameLocked: true, name: "Fix the Sidebar" });
    expect(sessionMatchesSearch(session, project, "sidebar")).toBe(true);
    expect(sessionMatchesSearch(session, project, "SIDEBAR")).toBe(true);
  });

  it("matches on the raw command even when a display title overrides it", () => {
    const session = makeSession({
      nameLocked: true,
      name: "Fix the Sidebar",
      command: "claude --dangerously-skip-permissions",
    });
    expect(sessionMatchesSearch(session, project, "dangerously")).toBe(true);
  });

  it("matches on the project's name", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "mullion")).toBe(true);
  });

  it("returns false when the query matches none of the three fields", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "nonexistent")).toBe(false);
  });

  it("returns true for an empty query (every field passes a blank substring check)", () => {
    const session = makeSession({ command: "claude code" });
    expect(sessionMatchesSearch(session, project, "")).toBe(true);
  });
});

describe("isListedSession", () => {
  const base = {
    hideEndedSessions: false,
    showTaskSessions: true,
    taskSessionIds: new Set<number>(),
  };

  it("lists an active terminal session", () => {
    expect(isListedSession(makeSession(), base)).toBe(true);
  });

  it("never lists a dock session or a killed one", () => {
    expect(isListedSession(makeSession({ kind: "dock" }), base)).toBe(false);
    expect(isListedSession(makeSession({ status: "killed" }), base)).toBe(false);
  });

  it("hides an exited session under hideEndedSessions unless includeExited is set", () => {
    const exited = makeSession({ status: "exited" });
    expect(isListedSession(exited, base)).toBe(true);
    expect(isListedSession(exited, { ...base, hideEndedSessions: true })).toBe(false);
    expect(isListedSession(exited, { ...base, hideEndedSessions: true, includeExited: true })).toBe(
      true,
    );
  });

  it("hides a task-linked session unless showTaskSessions is on", () => {
    const linked = makeSession({ id: 7 });
    const opts = { ...base, taskSessionIds: new Set([7]) };
    expect(isListedSession(linked, opts)).toBe(true);
    expect(isListedSession(linked, { ...opts, showTaskSessions: false })).toBe(false);
  });
});

// Issue #3285 — one order for every surface, one case per step.
describe("sessionTitle order (#3285)", () => {
  const bare = { nameLocked: false, name: null, lastTitle: null, command: "claude" };

  it("1. the user's name wins over everything", () => {
    const s = makeSession({
      ...bare,
      nameLocked: true,
      name: "mine",
      lastTitle: "osc",
      worktreeBranch: "feat/x",
    });
    expect(sessionDisplayTitle(s, { taskTitle: "Task", number: 2 })).toBe("mine");
  });

  it("2. a task's title wins over the agent's title and the branch", () => {
    const s = makeSession({ ...bare, lastTitle: "osc", worktreeBranch: "feat/x" });
    expect(sessionDisplayTitle(s, { taskTitle: "Fix the login form" })).toBe("Fix the login form");
  });

  it("3. the agent's title wins over the branch", () => {
    const s = makeSession({ ...bare, lastTitle: "osc", worktreeBranch: "feat/x" });
    expect(sessionDisplayTitle(s)).toBe("osc");
  });

  it("4. the session's own worktree branch wins over the launch name", () => {
    const s = makeSession({ ...bare, name: "Claude", worktreeBranch: "feat/x" });
    expect(sessionDisplayTitle(s)).toBe("feat/x");
  });

  it("5. the launch name, else the command, numbered past the first", () => {
    expect(sessionDisplayTitle(makeSession({ ...bare, name: "Claude Code" }))).toBe("Claude Code");
    expect(sessionDisplayTitle(makeSession(bare))).toBe("claude");
    expect(sessionDisplayTitle(makeSession(bare), { number: 1 })).toBe("claude");
    expect(sessionDisplayTitle(makeSession(bare), { number: 3 })).toBe("claude 3");
  });

  it("numbers only step 5, never a name, task, agent title or branch", () => {
    const s = makeSession({ ...bare, worktreeBranch: "feat/x" });
    expect(sessionDisplayTitle(s, { number: 2 })).toBe("feat/x");
  });

  it("gives pane headers the same title as the row", () => {
    const s = makeSession({ ...bare, name: "Claude", worktreeBranch: "feat/x" });
    expect(sessionPaneTitle(s, { taskTitle: "T" })).toBe(
      sessionDisplayTitle(s, { taskTitle: "T" }),
    );
    expect(sessionPaneTitle(s)).toBe("feat/x");
  });

  it("says when the title is the raw command, numbered or not", () => {
    expect(sessionTitleIsCommand(makeSession(bare), { number: 2 })).toBe(true);
    expect(sessionTitleIsCommand(makeSession({ ...bare, name: "Claude" }))).toBe(false);
    expect(sessionTitleIsCommand(makeSession(bare), { taskTitle: "T" })).toBe(false);
  });

  it("matches the search against the shown title", () => {
    const project = makeProject({ name: "p" });
    const s = makeSession(bare);
    expect(sessionMatchesSearch(s, project, "claude 2", { number: 2 })).toBe(true);
    expect(sessionMatchesSearch(s, project, "login", { taskTitle: "Fix the login" })).toBe(true);
  });
});

describe("buildSessionTitleContexts (#3285)", () => {
  const claude = (id: number, projectId: number) =>
    makeSession({
      id,
      projectId,
      name: null,
      nameLocked: false,
      lastTitle: null,
      command: "claude",
    });
  const titles = (
    sessions: ReturnType<typeof makeSession>[],
    ctx: ReturnType<typeof buildSessionTitleContexts>,
  ) => sessions.map((s) => sessionDisplayTitle(s, ctx.get(s.id)));

  it("numbers two unnamed claude sessions in one project in session id order", () => {
    const sessions = [claude(5, 1), claude(2, 1)];
    expect(titles(sessions, buildSessionTitleContexts(sessions, []))).toEqual([
      "claude 2",
      "claude",
    ]);
  });

  it("leaves sessions in different projects unnumbered", () => {
    const sessions = [claude(1, 1), claude(2, 2)];
    expect(titles(sessions, buildSessionTitleContexts(sessions, []))).toEqual(["claude", "claude"]);
  });

  it("does not count a session that resolves to other text", () => {
    const sessions = [claude(1, 1), { ...claude(2, 1), lastTitle: "busy" }];
    expect(titles(sessions, buildSessionTitleContexts(sessions, []))).toEqual(["claude", "busy"]);
  });

  it("counts an exited session, so a number never changes with a view's filter", () => {
    const sessions = [{ ...claude(1, 1), status: "exited" as const }, claude(2, 1)];
    const ctx = buildSessionTitleContexts(sessions, []);
    expect(titles(sessions, ctx)).toEqual(["claude", "claude 2"]);
  });

  it("does not count a killed session or a dock session", () => {
    const sessions = [
      { ...claude(1, 1), status: "killed" as const },
      { ...claude(2, 1), kind: "dock" as const },
      claude(3, 1),
    ];
    expect(sessionDisplayTitle(sessions[2], buildSessionTitleContexts(sessions, []).get(3))).toBe(
      "claude",
    );
  });

  it("gives a task's worker its task title, not its review session", () => {
    const sessions = [claude(1, 1), claude(2, 1), claude(3, 1)];
    const tasks = [makeTask({ id: 9, sessionId: 1, reviewSessionId: 3, title: "Fix the login" })];
    expect(titles(sessions, buildSessionTitleContexts(sessions, tasks))).toEqual([
      "Fix the login",
      "claude",
      "claude 2",
    ]);
  });

  it("memoizes on the store's inputs and resolves one session's title", () => {
    const sessions = [claude(1, 1), claude(2, 1)];
    const state = { sessions, tasks: [] };
    const first = selectSessionTitleContexts(state);
    expect(selectSessionTitleContexts({ ...state })).toBe(first);
    expect(selectSessionTitleContexts({ ...state, tasks: [] })).not.toBe(first);
    expect(selectSessionTitleContexts({ ...state, sessions: [...sessions] })).not.toBe(first);
    expect(selectSessionTitle(state, sessions[1])).toBe("claude 2");
  });
});

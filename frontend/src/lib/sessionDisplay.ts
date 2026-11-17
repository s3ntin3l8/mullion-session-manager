// Sidebar.tsx's display-title and search-matching helpers, extracted as
// PR 27 phase 1 (Wave 5, .claude/plans/can-we-do-a-warm-cocke.md) — genuinely
// pure (no hooks, no component state, no side effects), just not previously
// reachable by a direct unit test since Sidebar.tsx only exercised them
// indirectly through its own component tests.
import type { Project, Session, Task } from "../api/index.js";
import { matchesQuery } from "../matchQuery.js";

/**
 * What the title resolver cannot read from the Session itself (issue #3285):
 * the title of the task the session works on, and the session's number among
 * the listed sessions of its project that would otherwise show the same
 * launch name. Callers get both from `buildSessionTitleContexts` (or the
 * memoized `selectSessionTitleContexts`); a caller that passes nothing gets
 * the steps that need neither.
 */
export interface SessionTitleContext {
  taskTitle?: string | null;
  /** 1-based, in session id order; 1 (or absent) is shown without a number. */
  number?: number | null;
}

export type SessionTitleContexts = ReadonlyMap<number, SessionTitleContext>;

// Step 5's text: the launch name (a launch pattern's name, CommandPalette)
// when the session has one, else its raw command.
function launchTitle(session: Session): string {
  return session.name || session.command;
}

// The resolved title without step 5's number, and whether it came from
// step 5 — numbering only applies to that step.
function unnumberedTitle(
  session: Session,
  taskTitle: string | null | undefined,
): { title: string; fromLaunch: boolean } {
  if (session.nameLocked && session.name) return { title: session.name, fromLaunch: false };
  if (taskTitle) return { title: taskTitle, fromLaunch: false };
  if (session.lastTitle) return { title: session.lastTitle, fromLaunch: false };
  if (session.worktreeBranch) return { title: session.worktreeBranch, fromLaunch: false };
  return { title: launchTitle(session), fromLaunch: true };
}

/**
 * The one title a session has wherever it is listed (issue #3285): the sidebar
 * row, its search, the phone picker, the rail, pane headers and the palette.
 * In order:
 *  1. the name the user gave it (`nameLocked && name`);
 *  2. the title of the task it works on (a Task Master worker);
 *  3. the agent's own terminal title (`lastTitle`);
 *  4. its own worktree branch;
 *  5. its launch name or command, numbered within its project when another
 *     listed session there resolves to the same text ("claude", "claude 2").
 */
export function sessionTitle(session: Session, ctx?: SessionTitleContext): string {
  const { title, fromLaunch } = unnumberedTitle(session, ctx?.taskTitle);
  return fromLaunch && ctx?.number && ctx.number > 1 ? `${title} ${ctx.number}` : title;
}

/** Whether the resolved title is the session's raw command (unnumbered). */
export function sessionTitleIsCommand(session: Session, ctx?: SessionTitleContext): boolean {
  const { title, fromLaunch } = unnumberedTitle(session, ctx?.taskTitle);
  return fromLaunch && title === session.command;
}

// The sidebar row's title. The search filter (sessionMatchesSearch below)
// matches against exactly this text, so the two cannot drift.
export function sessionDisplayTitle(session: Session, ctx?: SessionTitleContext): string {
  return sessionTitle(session, ctx);
}

/**
 * The title a pane's header and the rail show, without the project suffix.
 * The same order as sessionDisplayTitle, so a session has one title on every
 * surface (#3010, #3285).
 */
export function sessionPaneTitle(session: Session, ctx?: SessionTitleContext): string {
  return sessionTitle(session, ctx);
}

/**
 * Each session's task title and number (issue #3285). The task title is the
 * title of the task whose worker the session is (`task.sessionId`); a review
 * session is not the task's worker and falls through to its own title.
 * Numbers are counted over the sessions the sidebar lists (isListedSession,
 * never the search- or chip-filtered subset, so typing does not renumber),
 * per project, among those whose title falls to step 5 with the same text, in
 * session id order. Sessions that need neither are absent from the map.
 */
export function buildSessionTitleContexts(
  sessions: readonly Session[],
  tasks: readonly Task[],
  listOpts: Pick<ListedSessionOptions, "hideEndedSessions" | "showTaskSessions">,
): Map<number, SessionTitleContext> {
  const taskTitleBySession = new Map<number, string>();
  const taskSessionIds = new Set<number>();
  for (const t of tasks) {
    if (t.sessionId !== null) {
      taskSessionIds.add(t.sessionId);
      if (t.title) taskTitleBySession.set(t.sessionId, t.title);
    }
    if (t.reviewSessionId !== null) taskSessionIds.add(t.reviewSessionId);
  }
  const contexts = new Map<number, SessionTitleContext>();
  for (const [id, taskTitle] of taskTitleBySession) contexts.set(id, { taskTitle });

  const groups = new Map<string, Session[]>();
  for (const s of sessions) {
    if (!isListedSession(s, { ...listOpts, taskSessionIds })) continue;
    const { title, fromLaunch } = unnumberedTitle(s, taskTitleBySession.get(s.id));
    if (!fromLaunch) continue;
    const key = `${s.projectId}\u0000${title}`;
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    [...group]
      .sort((a, b) => a.id - b.id)
      .forEach((s, i) => {
        contexts.set(s.id, { ...contexts.get(s.id), number: i + 1 });
      });
  }
  return contexts;
}

export interface SessionTitleState {
  sessions: Session[];
  tasks: Task[];
  hideEndedSessions: boolean;
  showTaskSessions: boolean;
}

let memo: { key: SessionTitleState; value: SessionTitleContexts } | null = null;

/**
 * buildSessionTitleContexts over the store's own state, memoized on the
 * identity of its inputs so every row, the rail and the search share one
 * build per store change. Usable as a store selector and through getState().
 */
export function selectSessionTitleContexts(state: SessionTitleState): SessionTitleContexts {
  if (
    memo &&
    memo.key.sessions === state.sessions &&
    memo.key.tasks === state.tasks &&
    memo.key.hideEndedSessions === state.hideEndedSessions &&
    memo.key.showTaskSessions === state.showTaskSessions
  ) {
    return memo.value;
  }
  const key = {
    sessions: state.sessions,
    tasks: state.tasks,
    hideEndedSessions: state.hideEndedSessions,
    showTaskSessions: state.showTaskSessions,
  };
  const value = buildSessionTitleContexts(state.sessions, state.tasks, key);
  memo = { key, value };
  return value;
}

/** One session's resolved title, straight from the store's state. */
export function selectSessionTitle(state: SessionTitleState, session: Session): string {
  return sessionTitle(session, selectSessionTitleContexts(state).get(session.id));
}

// U3 — the sidebar's own search box, reusing CommandPalette.tsx's (U2,
// #581) plain case-insensitive substring matcher rather than growing a
// second one (matchQuery.ts's own header comment covers why it's a plain
// substring test, not fuzzy). Matches on the session's displayed title,
// its raw command, and its *project's* name — typing a project name is
// meant to keep every one of that project's sessions visible, which falls
// out for free from including project.name as one of the per-session
// fields checked here.
export function sessionMatchesSearch(
  session: Session,
  project: Project,
  query: string,
  ctx?: SessionTitleContext,
): boolean {
  return matchesQuery([sessionDisplayTitle(session, ctx), session.command, project.name], query);
}

export interface ListedSessionOptions {
  hideEndedSessions: boolean;
  showTaskSessions: boolean;
  taskSessionIds: ReadonlySet<number>;
  // The sidebar's explicit "Exited" chip bypasses hideEndedSessions for its
  // own selection (see Sidebar.tsx's baseSessionsByProject); the phone
  // picker has no chips and leaves this unset.
  includeExited?: boolean;
}

// The exact "is this session listed at all" predicate Sidebar.tsx has always
// applied per project (kind === "terminal", not killed, hideEndedSessions,
// showTaskSessions), extracted so the phone session picker lists precisely
// the same sessions as the sidebar instead of growing a second copy that
// could drift. Project membership stays with the caller.
export function isListedSession(session: Session, opts: ListedSessionOptions): boolean {
  return (
    session.kind === "terminal" &&
    session.status !== "killed" &&
    (!opts.hideEndedSessions || session.status === "active" || opts.includeExited === true) &&
    (opts.showTaskSessions || !opts.taskSessionIds.has(session.id))
  );
}

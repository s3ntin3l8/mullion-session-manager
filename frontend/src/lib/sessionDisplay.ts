// Sidebar.tsx's display-title and search-matching helpers, extracted as
// PR 27 phase 1 (Wave 5, .claude/plans/can-we-do-a-warm-cocke.md) — genuinely
// pure (no hooks, no component state, no side effects), just not previously
// reachable by a direct unit test since Sidebar.tsx only exercised them
// indirectly through its own component tests.
import type { Project, Session } from "../api/index.js";
import { matchesQuery } from "../matchQuery.js";

// U3 (audit finding — "nothing degrades gracefully past ~20 sessions") —
// the sidebar's own display-name precedence, factored out so the search
// filter (sessionMatchesSearch below) can match against exactly the same
// text SessionRow itself renders as the row's title, instead of drifting
// from it. Also used directly by SessionRow's own `title` computation.
export function sessionDisplayTitle(session: Session): string {
  return session.nameLocked && session.name
    ? session.name
    : session.lastTitle
      ? session.lastTitle
      : session.command;
}

// U3 — the sidebar's own search box, reusing CommandPalette.tsx's (U2,
// #581) plain case-insensitive substring matcher rather than growing a
// second one (matchQuery.ts's own header comment covers why it's a plain
// substring test, not fuzzy). Matches on the session's displayed title,
// its raw command, and its *project's* name — typing a project name is
// meant to keep every one of that project's sessions visible, which falls
// out for free from including project.name as one of the per-session
// fields checked here.
export function sessionMatchesSearch(session: Session, project: Project, query: string): boolean {
  return matchesQuery([sessionDisplayTitle(session), session.command, project.name], query);
}

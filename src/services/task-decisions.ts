import type { FastifyInstance } from "fastify";
import { getCommitMessagesAhead } from "./git-log.js";
import { resolveHostBaseRef, resolveHostGitCommit, resolveHostGitLog } from "./host-git.js";
import { LOCAL_HOST_ID } from "./host-registry.js";
import { redactSecrets } from "./scaffold-failure.js";

// The worker's declared departures from the issue (#2599). The worker prompt
// asks it to record each one as a commit-body line starting with one of
// `DECISION_PREFIXES`; those lines only live in commit bodies, so Mullion
// collects them from `<base>..HEAD` and shows them to the reviewer and in the
// PR description, where a human can see them.

/** The line-start prefixes the worker is asked to use. */
export const DECISION_PREFIXES = ["Decision:", "Skipped:", "Deferred:", "Not run locally:"];

export const MAX_DECISION_LINES = 20;
export const MAX_DECISION_LINE_LENGTH = 300;
/** Commits read per task: a task is one worktree's work, so this is generous. */
const MAX_COMMITS = 50;

/**
 * The declared-decision lines of `messages` (full commit messages), in the
 * order given: lines that start (after optional indentation or a list marker)
 * with a known prefix. Each is redacted, then cut to
 * `MAX_DECISION_LINE_LENGTH`, and at most `MAX_DECISION_LINES` are kept.
 * The subject line is not scanned: a decision is a body line.
 */
export function extractDeclaredDecisions(messages: string[]): string[] {
  const out: string[] = [];
  for (const message of messages) {
    const lines = message.split(/\r?\n/).slice(1);
    for (const raw of lines) {
      const line = raw.replace(/^\s*(?:[-*]\s+)?/, "").trimEnd();
      if (!DECISION_PREFIXES.some((p) => line.startsWith(p))) continue;
      // Redact before cutting, so a secret straddling the cut is not left half-shown.
      const redacted = redactSecrets(line);
      out.push(
        redacted.length > MAX_DECISION_LINE_LENGTH
          ? `${redacted.slice(0, MAX_DECISION_LINE_LENGTH - 1)}…`
          : redacted,
      );
      if (out.length >= MAX_DECISION_LINES) return out;
    }
  }
  return out;
}

/**
 * Collects the declared decisions of the task branch checked out at
 * `worktreePath` on `hostId`. Best-effort: anything unreadable yields `[]`,
 * because a missing section must never block a review or a PR.
 *
 * `projectCwd` is where the base ref is resolved (the project root, as
 * `task-promote.ts` does). A local host reads `git log <base>..HEAD`; a
 * remote host is read through its history routes, walking HEAD back to the
 * base commit.
 */
export async function collectDeclaredDecisions(
  app: FastifyInstance,
  task: { worktreePath: string | null },
  project: { cwd: string },
  hostId: string,
): Promise<string[]> {
  const projectCwd = project.cwd;
  const worktreePath = task.worktreePath;
  if (worktreePath === null) return [];
  try {
    const base = await resolveHostBaseRef(app, hostId, projectCwd);
    if (!base.ok) return [];
    if (hostId === LOCAL_HOST_ID) {
      const messages = await getCommitMessagesAhead(worktreePath, base.value.baseRef, MAX_COMMITS);
      return extractDeclaredDecisions(messages ?? []);
    }
    const log = await resolveHostGitLog(app, hostId, projectCwd, {
      worktree: worktreePath,
      skip: 0,
      limit: MAX_COMMITS,
      scope: "head",
    });
    if (!log.ok || log.value.forbidden || log.value.value === null) return [];
    const ahead: string[] = [];
    for (const entry of log.value.value) {
      if (entry.sha === base.value.sha) break;
      ahead.push(entry.sha);
    }
    const messages: string[] = [];
    for (const sha of ahead) {
      const detail = await resolveHostGitCommit(app, hostId, projectCwd, sha, worktreePath);
      if (detail.ok && !detail.value.forbidden && detail.value.value) {
        messages.push(detail.value.value.message);
      }
    }
    return extractDeclaredDecisions(messages);
  } catch (err) {
    app.log.warn({ err }, "task decisions: could not read the branch's commit messages");
    return [];
  }
}

const SECTION_START = "<!-- mullion:worker-decisions -->";
const SECTION_END = "<!-- /mullion:worker-decisions -->";
const SECTION_RE = new RegExp(`\\n*${SECTION_START}[\\s\\S]*?${SECTION_END}`);

/** The PR-description section for `decisions`, or `""` when there are none.
 * Wrapped in markers so a refresh can replace exactly this section. */
export function renderWorkerDecisionsSection(decisions: string[]): string {
  if (decisions.length === 0) return "";
  return [
    SECTION_START,
    "### Worker decisions",
    "",
    ...decisions.map((d) => `- ${d}`),
    SECTION_END,
  ].join("\n");
}

/**
 * `body` with its worker-decisions section set to `decisions`: replaced in
 * place, removed when there are none, or — for a body without one — inserted
 * above the "---" footer Task Master writes (or appended). Returns `body`
 * unchanged when nothing needs to change.
 */
export function applyWorkerDecisionsSection(body: string, decisions: string[]): string {
  const section = renderWorkerDecisionsSection(decisions);
  if (SECTION_RE.test(body)) {
    return body.replace(SECTION_RE, () => (section === "" ? "" : `\n\n${section}`));
  }
  if (section === "") return body;
  const footer = body.lastIndexOf("\n\n---\n");
  if (footer === -1) return `${body}\n\n${section}`;
  return `${body.slice(0, footer)}\n\n${section}${body.slice(footer)}`;
}

// Auto-enables `projects.conventionalCommitTitles` for a project whose repo
// has release-please's own config committed — the fix for the branchdam-mobile
// incident: with the flag off (the historical default), Task Master's PR
// titles were the raw GitHub issue title verbatim, and that repo's own issue
// titles used task-label prefixes (`[T2-7b] ...`) rather than Conventional
// Commits ones. release-please's parser rejected 16 of 21 squash-merged
// commits since the last release, and `release-please-action` exits 0 on "no
// release needed" — so the failure was completely silent for weeks. See
// docs/tasks.md's "Commit title caveat, and the opt-in fix (#761)" section
// for the feature this sweep now turns on automatically where it matters.
import type { FastifyInstance } from "fastify";
import { and, eq, isNull } from "drizzle-orm";
import { projects } from "../db/schema.js";
import { resolveRepoRefResult } from "./host-git.js";
import { resolveGitHubToken } from "./github-integration.js";
import { detectReleasePleaseConfig } from "./github.js";

type ProjectRow = typeof projects.$inferSelect;

interface MaybeAutoEnableOptions {
  // Issue #1034 — the manual re-check affordance in the project edit
  // modal. By default this sweep is one-shot (see below), so a repo that
  // adopts release-please AFTER first detection never gets re-probed by
  // the reconciler tick; this option forces a fresh probe by bypassing the
  // `conventionalCommitTitlesResolvedAt` early-return gate AND relaxing
  // the `isNull` race guard in `commitResolution` so the new stamp can
  // overwrite the old one. The narrower race (a human PATCHing
  // conventionalCommitTitles while this re-check's network calls are in
  // flight) still loses to the human: their PATCH runs after our read of
  // the row, so by the time our write lands the value reflects their
  // choice and the human's stamp is just newer than ours.
  ignoreStamp?: boolean;
}

/**
 * One-shot per project: bails immediately once
 * `conventionalCommitTitlesResolvedAt` is set, by ANYONE — this sweep or a
 * human PATCHing the field directly (routes/projects.ts's PATCH handler
 * stamps it too, so a human's explicit choice always wins even if it
 * predates this sweep ever running — see that column's own doc comment in
 * schema.ts). The exception is `{ ignoreStamp: true }` (issue #1034), which
 * forces a fresh probe from the manual re-check endpoint.
 *
 * Never throws — modeled on `maybeRegisterProjectWebhook`'s own contract
 * (routes/projects.ts): a project create, or a reconciler tick sweeping many
 * projects, must never fail because GitHub is unreachable or unconfigured.
 * A transient failure (host unreachable, no token configured, GitHub rate
 * limited) leaves the project unresolved so a later call gets another
 * chance — only a DEFINITE detection result (repo has no GitHub remote at
 * all, or a successful contents-API lookup either way) stamps
 * `conventionalCommitTitlesResolvedAt`, which is what makes each project
 * cost at most one real detection attempt rather than being re-probed on
 * every tick forever.
 *
 * Returns the project row as it now stands in the DB — unchanged when the
 * sweep bailed or the repo doesn't have release-please, updated when it
 * turned the flag on. Callers that need the fresh row (a project-create
 * response, so the client can surface "we turned this on for you") get it
 * without a second read.
 */
export async function maybeAutoEnableConventionalTitles(
  app: FastifyInstance,
  row: ProjectRow,
  options: MaybeAutoEnableOptions = {},
): Promise<ProjectRow> {
  if (!options.ignoreStamp && row.conventionalCommitTitlesResolvedAt !== null) return row;

  try {
    const repoRefResult = await resolveRepoRefResult(app, row);
    if (!repoRefResult.ok) {
      // Host unreachable / an old agent build that doesn't support the
      // resolve-repo route yet — transient from this sweep's point of view.
      // Leave unresolved; a later create-time call or reconciler tick tries
      // again.
      return row;
    }
    if (repoRefResult.value === null) {
      // Definite: this project's cwd has no github.com remote configured at
      // all. Nothing about that changes on its own, so this is a real
      // negative, not a "try again later" — stamp it so the sweep doesn't
      // keep re-resolving git remotes for a project that will never have
      // one without a human changing its cwd (a cwd change is a separate,
      // deliberate edit — not something this sweep watches for; see the
      // "re-check when a repo adopts release-please later" follow-up).
      return stampResolved(app, row, options);
    }
    const repoRef = repoRefResult.value;

    const token = await resolveGitHubToken(app, repoRef, "read");
    if (token === null) {
      // No PAT/OAuth token and no GitHub App installed for this owner yet —
      // transient in the sense that configuring GitHub integration later
      // should get this project a real chance. Leave unresolved.
      return row;
    }

    const detected = await detectReleasePleaseConfig(token, repoRef.owner, repoRef.repo);
    if (detected === null) {
      // Rate-limited, no `contents: read` scope, a 5xx — couldn't tell.
      // Leave unresolved rather than latching a false negative.
      return row;
    }
    if (!detected) return stampResolved(app, row, options);

    // Definite positive: this repo has release-please-config.json or
    // .release-please-manifest.json committed. Write over a stored `0` —
    // that's the entire point (branchdam-mobile, this repo, and branchDAM
    // were all an explicit `0`, not null, at the time this shipped) — this
    // is safe because task-promote.ts's resolvePrTitle keeps an
    // already-conventional issue title in preference to the worker's, so a
    // repo that was already fine sees no behavior change.
    return commitResolution(app, row, { conventionalCommitTitles: true }, options);
  } catch (err) {
    app.log.warn(
      { err, projectId: row.id },
      "release-please auto-enable: could not determine this project's release-please status",
    );
    return row;
  }
}

function stampResolved(
  app: FastifyInstance,
  row: ProjectRow,
  options: MaybeAutoEnableOptions,
): ProjectRow {
  return commitResolution(app, row, {}, options);
}

/**
 * The only writer of `conventionalCommitTitlesResolvedAt` in this file —
 * every call site routes through here so the concurrency guard below can't
 * be forgotten at a new one.
 *
 * `resolveRepoRefResult`/`resolveGitHubToken`/`detectReleasePleaseConfig`
 * above are real network round trips the caller awaits one after another,
 * during which a human can PATCH `conventionalCommitTitles` directly
 * (routes/projects.ts) — which stamps `conventionalCommitTitlesResolvedAt`
 * itself, precisely so a decision made before this sweep's first pass still
 * wins permanently. Without the `isNull` guard here, this sweep's own write
 * — issued against the `row` it read at the START of that awaited chain —
 * would silently clobber that concurrent human decision the instant this
 * call landed, the exact race the "human wins permanently" contract exists
 * to prevent. `.returning()` empty means someone else already resolved this
 * project first; re-read the current row rather than trusting the stale
 * `row` this function was called with.
 *
 * `ignoreStamp: true` (issue #1034) — the manual re-check is allowed to
 * overwrite an existing stamp, since the whole point is to land a NEW
 * detection result. On a positive detection (set is non-empty) the
 * re-check's write intentionally overwrites a human's mid-flight PATCH —
 * that is the documented purpose of the affordance. The narrower case
 * still preserves the human's choice: when the new detection result is
 * negative or "no remote", the `set` is `{}` and the only thing this
 * UPDATE touches is the stamp itself, so a human's PATCH made during the
 * network window still wins on the column.
 */
function commitResolution(
  app: FastifyInstance,
  row: ProjectRow,
  set: { conventionalCommitTitles?: true },
  options: MaybeAutoEnableOptions,
): ProjectRow {
  const where = options.ignoreStamp
    ? eq(projects.id, row.id)
    : and(eq(projects.id, row.id), isNull(projects.conventionalCommitTitlesResolvedAt));
  const updated = app.db
    .update(projects)
    .set({ ...set, conventionalCommitTitlesResolvedAt: new Date() })
    .where(where)
    .returning()
    .all();
  if (updated[0]) return updated[0];
  const [current] = app.db.select().from(projects).where(eq(projects.id, row.id)).all();
  return current ?? row;
}

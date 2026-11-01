ALTER TABLE `tasks` ADD `superseded_at` integer;--> statement-breakpoint
-- #2292 — mark the copies a project merge already superseded, so Retry refuses
-- them too (the marker is what a fresh merge writes; this backfills it for the
-- rows that predate the column).
--
-- THE MERGE SIGNATURE, not "archived": project-merge.ts is the ONLY writer that
-- clears `issue_number` — it does so on exactly the two supersede paths — so a
-- row that has no issue number but still carries an `html_url` was GitHub-linked
-- and lost its issue to a merge. (`html_url` is set together with
-- `issue_number` at ingest — a local task has neither, a watcher-ingested one
-- has both — and it is never cleared.) The two `failure_reason` patterns are
-- the merge's own wording (see task-supersede.ts's reason builders), kept as a
-- second signal for rows old enough to predate `html_url`.
--
-- NOT gated on `archived_at`: DELETE /api/tasks/:id/archive has no status
-- guard, so a superseded copy can be unarchived by a human — and an UNARCHIVED
-- copy in a queued status is claimable (the claim guards are archived-only:
-- task-claim.ts's enqueueTask and task-watcher.ts's auto-claim sweep). Keying
-- on the merge signature covers the unarchived case exactly as well as the
-- archived one.
--
-- The wording alone would NOT be enough: the merge keeps an EXISTING failure
-- reason (`failureReason ?? …`), so the wording says nothing about a copy that
-- had already failed before the merge — the `html_url` signal is what covers
-- those.
UPDATE `tasks` SET `superseded_at` = CAST(strftime('%s','now') AS INTEGER)
WHERE `superseded_at` IS NULL
  AND `issue_number` IS NULL
  AND (
    `html_url` IS NOT NULL
    OR `failure_reason` LIKE 'Merged from project #%'
    OR `failure_reason` LIKE 'Replaced by task #%'
  );--> statement-breakpoint
-- #2292 — normalize: a superseded copy that was still `ready`/`backlog` leaves
-- the queue. It is not claimable while it is archived (the auto-claim sweep
-- and enqueueTask both refuse archived rows), but it shows up as a claim-less
-- "ready" row in the archived view — and once a human unarchives it, it IS
-- claimable. Move it to `failed`, keeping its reason; give it a generic one
-- when it has none.
--
-- The predicate is the merge signature again, widened by `archived_at`: a
-- queued task that is archived was archived by a merge (every other
-- `archivedAt` writer touches a `done` task, and the manual archive route
-- rejects anything that is not `done`/`failed`), so it is superseded too even
-- when it predates `html_url` and the merge's wording never reached it. The
-- `issue_number IS NULL` clause keeps that widening from touching a queued
-- task that still tracks an issue.
--
-- `superseded_at` is set here as well: a row this statement normalizes IS a
-- superseded copy (that is why it is being normalized), and marking it is
-- what keeps a later unarchive from re-arming it.
UPDATE `tasks`
SET `status` = 'failed',
    `failure_reason` = COALESCE(
      `failure_reason`,
      'Superseded by a project merge; it was left in a queued status by an earlier Mullion version.'
    ),
    `superseded_at` = COALESCE(`superseded_at`, CAST(strftime('%s','now') AS INTEGER))
WHERE `status` IN ('ready', 'backlog')
  AND `issue_number` IS NULL
  AND (
    `archived_at` IS NOT NULL
    OR `html_url` IS NOT NULL
    OR `failure_reason` LIKE 'Merged from project #%'
    OR `failure_reason` LIKE 'Replaced by task #%'
  );

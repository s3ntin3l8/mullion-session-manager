ALTER TABLE `tasks` ADD `superseded_at` integer;--> statement-breakpoint
-- #2292 — mark the copies an EARLIER project merge already superseded, so
-- Retry refuses them too (the marker is what a fresh merge writes; this
-- backfills it for the rows that predate the column).
--
-- project-merge.ts is the ONLY writer that clears `issue_number` — it does so
-- on exactly the two supersede paths, where it also archives the row. A task
-- row therefore still carries its `issue_number` unless a merge superseded it.
-- And a row that still carries `html_url` was GitHub-linked (the two task
-- insertion sites set `issue_number` and `html_url` together: a local task
-- has neither, a watcher-ingested one has both, and `html_url` is never
-- cleared). So "archived + issue number cleared + was GitHub-linked"
-- identifies a merge-superseded copy exactly, while a manually archived
-- LOCAL task (`html_url` null) and a manually archived GitHub task
-- (`issue_number` still set) are both correctly left alone.
--
-- The two `failure_reason` patterns are the merge's own wording (see
-- task-supersede.ts's reason builders), kept as a second signal for rows old
-- enough to predate `html_url`. The merge keeps an EXISTING failure reason
-- (`failureReason ?? …`), so the wording alone would miss a copy that had
-- already failed before the merge — the `html_url` signal is what covers
-- those.
UPDATE `tasks` SET `superseded_at` = CAST(strftime('%s','now') AS INTEGER)
WHERE `superseded_at` IS NULL
  AND `archived_at` IS NOT NULL
  AND `issue_number` IS NULL
  AND (
    `html_url` IS NOT NULL
    OR `failure_reason` LIKE 'Merged from project #%'
    OR `failure_reason` LIKE 'Replaced by task #%'
  );--> statement-breakpoint
-- #2292 — normalize: a copy archived by a merge BEFORE #2291 stayed in a
-- queued status. It is not claimable (the auto-claim sweep and enqueueTask
-- both refuse archived rows), but it shows up as a claim-less "ready" row in
-- the archived view. Move it to `failed`, keeping its reason; give it a
-- generic one when it has none.
--
-- Deliberately NOT restricted to the rows marked above: only a merge archives
-- a queued task (every other `archivedAt` writer touches a `done` task, and
-- the manual archive route rejects anything that is not `done`/`failed`), so
-- this set is exactly the merge-superseded copies — and normalizing all of
-- them is what keeps a pre-`html_url` row from staying `ready` forever.
UPDATE `tasks`
SET `status` = 'failed',
    `failure_reason` = COALESCE(
      `failure_reason`,
      'Superseded by a project merge; it was left in a queued status by an earlier Mullion version.'
    )
WHERE `archived_at` IS NOT NULL
  AND `status` IN ('ready', 'backlog');

-- Issue #213 cross-host capture: dedupe existing rows before the unique
-- index below can be created. NULL session_id rows are excluded from both
-- this DELETE and the index's dedupe guarantee (SQLite treats NULLs as
-- distinct in a UNIQUE index) — see schema.ts's own doc comment on
-- session_events.
DELETE FROM `session_events`
WHERE `session_id` IS NOT NULL
  AND `id` NOT IN (
    SELECT MAX(`id`)
    FROM `session_events`
    WHERE `session_id` IS NOT NULL
    GROUP BY `session_id`, `seq`, `ts`, `kind`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `session_events_dedupe_idx` ON `session_events` (`session_id`,`seq`,`ts`,`kind`);

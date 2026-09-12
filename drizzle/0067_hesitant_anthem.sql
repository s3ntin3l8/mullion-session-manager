-- Issue #1223: before the unique index below can be created, an existing
-- install may already hold multiple `status: 'active'` `docker-stack:<x>`
-- rows for the same project — that's the exact pre-existing race this
-- index guards against. Unlike 0033_tan_bloodstorm.sql (which deletes
-- duplicate session_events rows — safe, they're just a log), a duplicate
-- SESSION row must not be deleted: it's session history. Flip every
-- duplicate but the newest (by id) to `exited` instead, so `ensureDb()`'s
-- migration run (src/db/client.ts, executed at every boot) can't fail on
-- an install that ever hit the race this issue fixes.
UPDATE `sessions` SET `status` = 'exited'
WHERE `kind` = 'dock' AND `status` = 'active' AND `name` LIKE 'docker-stack:%'
  AND `id` NOT IN (
    SELECT MAX(`id`) FROM `sessions`
    WHERE `kind` = 'dock' AND `status` = 'active' AND `name` LIKE 'docker-stack:%'
    GROUP BY `project_id`, `name`
  );
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_stack_identity_unique` ON `sessions` (`project_id`,`name`) WHERE kind = 'dock' AND status = 'active' AND name LIKE 'docker-stack:%';

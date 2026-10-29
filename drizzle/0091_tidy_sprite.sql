ALTER TABLE `tasks` ADD `approval_notified_verdict_at` integer;
--> statement-breakpoint
-- #2252 — tasks already waiting on a human must not be announced on deploy.
UPDATE `tasks` SET `approval_notified_verdict_at` = `last_review_verdict_at` WHERE `status` = 'reviewing';

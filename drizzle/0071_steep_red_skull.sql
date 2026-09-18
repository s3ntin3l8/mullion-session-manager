ALTER TABLE `tasks` ADD `last_review_verdict_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `inconclusive_review_rearm_count` integer DEFAULT 0 NOT NULL;

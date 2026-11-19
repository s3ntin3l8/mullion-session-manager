ALTER TABLE `tasks` ADD `nudge_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_nudged_at` integer;

ALTER TABLE `tasks` ADD `rebase_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rebase_started_at` integer;

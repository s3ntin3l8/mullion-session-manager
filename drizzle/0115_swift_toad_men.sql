ALTER TABLE `tasks` ADD `ci_return_head_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `ci_rerun_count` integer DEFAULT 0 NOT NULL;

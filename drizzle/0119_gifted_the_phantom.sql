ALTER TABLE `tasks` ADD `coverage_reupload_head_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `coverage_reupload_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `coverage_reupload_at` integer;

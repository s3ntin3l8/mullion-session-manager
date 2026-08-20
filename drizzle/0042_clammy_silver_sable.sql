ALTER TABLE `projects` ADD `merge_on_approve` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_approve` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `merge_requested_at` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `merge_error` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_review_verdict` text;

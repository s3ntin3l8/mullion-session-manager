ALTER TABLE `tasks` ADD `dependency_count` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `blocked_by` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `blocked_by_checked_at` integer;--> statement-breakpoint
ALTER TABLE `webhook_registrations` ADD `events_version` integer DEFAULT 0 NOT NULL;

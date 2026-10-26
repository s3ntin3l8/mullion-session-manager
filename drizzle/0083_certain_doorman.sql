ALTER TABLE `tasks` ADD `dispatch_failing_since` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `dispatch_held` integer DEFAULT false NOT NULL;

ALTER TABLE `tasks` ADD `parent_issue_state` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_sub_issue_total` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_sub_issue_completed` integer;

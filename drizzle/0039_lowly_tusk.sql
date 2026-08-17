ALTER TABLE `tasks` ADD `parent_issue_number` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_issue_repo` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `parent_issue_title` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sub_issue_total` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sub_issue_completed` integer;

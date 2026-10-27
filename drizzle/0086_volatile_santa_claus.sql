DROP INDEX `previews_project_id_unique`;--> statement-breakpoint
ALTER TABLE `previews` ADD `branch` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `previews` ADD `upstream_port` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `previews_project_id_branch_unique` ON `previews` (`project_id`,`branch`);

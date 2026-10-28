CREATE TABLE `project_preview_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` integer NOT NULL,
	`name` text NOT NULL,
	`destination` text NOT NULL,
	`connection_origin` text DEFAULT 'project' NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
DROP INDEX `previews_project_id_branch_unique`;--> statement-breakpoint
ALTER TABLE `previews` ADD `target_id` text REFERENCES project_preview_targets(id) ON DELETE CASCADE;--> statement-breakpoint
CREATE UNIQUE INDEX `previews_target_id_unique` ON `previews` (`target_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_project_id_branch_unique` ON `previews` (`project_id`,`branch`) WHERE "previews"."kind" = 'project';

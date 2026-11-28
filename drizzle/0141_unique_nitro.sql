CREATE TABLE `workspace_pinned_projects` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workspace_pinned_projects_workspace_project_unique` ON `workspace_pinned_projects` (`workspace_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `workspace_pinned_projects_project_idx` ON `workspace_pinned_projects` (`project_id`);
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_project_tooling` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`briefing` text,
	`skill` text,
	`reviewer_agent` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_project_tooling`("id", "project_id", "briefing", "updated_at") SELECT "id", "project_id", "briefing", "updated_at" FROM `project_tooling`;--> statement-breakpoint
DROP TABLE `project_tooling`;--> statement-breakpoint
ALTER TABLE `__new_project_tooling` RENAME TO `project_tooling`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `project_tooling_project_id_unique` ON `project_tooling` (`project_id`);

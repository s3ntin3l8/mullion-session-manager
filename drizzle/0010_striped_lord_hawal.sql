CREATE TABLE `previews` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`project_id` integer,
	`external_url` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `previews_slug_unique` ON `previews` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `previews_project_id_unique` ON `previews` (`project_id`);--> statement-breakpoint
ALTER TABLE `projects` ADD `dev_server_url` text;
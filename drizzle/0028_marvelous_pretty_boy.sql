CREATE TABLE `webhook_registrations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`owner` text NOT NULL,
	`repo` text NOT NULL,
	`hook_id` integer,
	`registered_at` integer,
	`last_error` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_registrations_project_id_unique` ON `webhook_registrations` (`project_id`);

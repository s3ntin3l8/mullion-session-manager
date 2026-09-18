PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_devices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text DEFAULT 'local' NOT NULL,
	`project_id` integer,
	`name` text,
	`kind` text DEFAULT 'emulator' NOT NULL,
	`avd_name` text,
	`serial` text,
	`port` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_devices`("id", "host_id", "project_id", "name", "avd_name", "port", "status", "created_at") SELECT "id", "host_id", "project_id", "name", "avd_name", "port", "status", "created_at" FROM `devices`;--> statement-breakpoint
DROP TABLE `devices`;--> statement-breakpoint
ALTER TABLE `__new_devices` RENAME TO `devices`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `devices_project_id_idx` ON `devices` (`project_id`);

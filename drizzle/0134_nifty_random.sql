CREATE TABLE `host_identity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`peer` text,
	`acknowledged_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `host_identity_events_host_at_idx` ON `host_identity_events` (`host_id`,`at`);
CREATE TABLE `session_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`session_id` integer,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`ts` integer NOT NULL,
	`payload` text,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `session_events_session_id_ts_idx` ON `session_events` (`session_id`,`ts`);

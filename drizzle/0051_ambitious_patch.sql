CREATE TABLE `bridges` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text,
	`pairing_secret_enc` text,
	`pairing_expires_at` integer,
	`session_id_enc` text,
	`session_secret_enc` text,
	`session_expires_at` integer,
	`platform` text,
	`last_seen_at` integer,
	`created_at` integer NOT NULL
);

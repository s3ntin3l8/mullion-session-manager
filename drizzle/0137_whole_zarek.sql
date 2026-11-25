CREATE TABLE `automation_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`expires_at` integer NOT NULL,
	`allowed_cidrs` text,
	`require_approval` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `automation_tokens_secret_hash_idx` ON `automation_tokens` (`secret_hash`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_host_identity_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`host_id` text,
	`kind` text NOT NULL,
	`at` integer NOT NULL,
	`peer` text,
	`label` text,
	`acknowledged_at` integer,
	FOREIGN KEY (`host_id`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_host_identity_events`("id", "host_id", "kind", "at", "peer", "acknowledged_at") SELECT "id", "host_id", "kind", "at", "peer", "acknowledged_at" FROM `host_identity_events`;--> statement-breakpoint
DROP TABLE `host_identity_events`;--> statement-breakpoint
ALTER TABLE `__new_host_identity_events` RENAME TO `host_identity_events`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `host_identity_events_host_at_idx` ON `host_identity_events` (`host_id`,`at`);--> statement-breakpoint
CREATE INDEX `host_identity_events_ack_kind_at_idx` ON `host_identity_events` (`acknowledged_at`,`kind`,`at`);--> statement-breakpoint
ALTER TABLE `host_pairings` ADD `minted_by_token_id` text;--> statement-breakpoint
ALTER TABLE `host_pairings` ADD `require_approval` integer DEFAULT false NOT NULL;
CREATE TABLE `host_pairings` (
	`id` text PRIMARY KEY NOT NULL,
	`code_enc` text,
	`expires_at` integer NOT NULL,
	`label` text,
	`redeemed_at` integer,
	`redeemed_host_id` text,
	`redeem_request_hash` text,
	`revoked_at` integer,
	`created_at` integer NOT NULL
);

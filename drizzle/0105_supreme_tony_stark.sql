ALTER TABLE `hosts` ADD `machine_credential_enc` text;--> statement-breakpoint
ALTER TABLE `hosts` ADD `machine_credential_prev_enc` text;--> statement-breakpoint
ALTER TABLE `hosts` ADD `machine_credential_rotated_at` integer;--> statement-breakpoint
ALTER TABLE `hosts` ADD `machine_credential_expires_at` integer;--> statement-breakpoint
ALTER TABLE `hosts` ADD `machine_credential_revoked_at` integer;

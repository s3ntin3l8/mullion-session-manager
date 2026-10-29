ALTER TABLE `hosts` ADD `role` text DEFAULT 'worker' NOT NULL;--> statement-breakpoint
UPDATE `hosts` SET `role` = 'main' WHERE `id` = 'local';

ALTER TABLE `previews` ADD `session_id` integer REFERENCES sessions(id) ON DELETE set null;

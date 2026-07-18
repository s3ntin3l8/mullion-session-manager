CREATE TABLE `integrations` (
	`provider` text PRIMARY KEY NOT NULL,
	`auth_token_enc` text,
	`token_type` text,
	`login` text,
	`scopes` text,
	`connected_at` integer
);

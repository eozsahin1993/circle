CREATE TABLE `pending_join_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`invite_code` text NOT NULL,
	`circle_name` text NOT NULL,
	`created_by_public_key` text NOT NULL,
	`ephemeral_public_key` text NOT NULL,
	`submitted_at` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL
);

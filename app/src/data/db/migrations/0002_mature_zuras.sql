CREATE TABLE IF NOT EXISTS `circle_invites` (
	`code` text PRIMARY KEY NOT NULL,
	`circle_id` text NOT NULL,
	`created_by_public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `circle_invites_circle_id` ON `circle_invites` (`circle_id`);
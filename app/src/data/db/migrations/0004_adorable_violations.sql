CREATE TABLE IF NOT EXISTS `outbox` (
	`sequence_num` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`circle_id` text NOT NULL,
	`entry_type` text NOT NULL,
	`entry_id` text NOT NULL,
	`encrypted_meta` blob NOT NULL,
	`status` text NOT NULL,
	`epoch` integer,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `outbox_circle_id` ON `outbox` (`circle_id`);
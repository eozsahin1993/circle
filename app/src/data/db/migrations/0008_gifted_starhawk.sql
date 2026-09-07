CREATE TABLE `member_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`circle_id` text NOT NULL,
	`epoch` integer NOT NULL,
	`kind` text NOT NULL,
	`subject_public_key` text NOT NULL,
	`actor_public_key` text NOT NULL,
	`role` text,
	`occurred_at` integer NOT NULL,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `member_events_circle_epoch` ON `member_events` (`circle_id`,`epoch`);
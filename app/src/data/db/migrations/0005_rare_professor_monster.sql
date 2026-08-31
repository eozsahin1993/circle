CREATE TABLE `post_reactions` (
	`post_id` text NOT NULL,
	`member_id` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `member_id`, `emoji`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `post_reactions_post_id` ON `post_reactions` (`post_id`);
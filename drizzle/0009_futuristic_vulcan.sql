CREATE TABLE `comments` (
	`id` text PRIMARY KEY NOT NULL,
	`article_id` text NOT NULL,
	`parent_id` text,
	`author_name` text NOT NULL,
	`author_email` text NOT NULL,
	`body` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`ip_hash` text,
	`submitted_at` text NOT NULL,
	`moderated_by` text,
	`moderated_at` text,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`moderated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
ALTER TABLE `articles` ADD `comments_mode` text DEFAULT 'inherit' NOT NULL;
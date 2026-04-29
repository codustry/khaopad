CREATE TABLE `slug_redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`old_slug` text NOT NULL,
	`new_slug` text NOT NULL,
	`article_id` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`article_id`) REFERENCES `articles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slug_redirects_old_slug_unique` ON `slug_redirects` (`old_slug`);
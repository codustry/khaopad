CREATE TABLE `page_views` (
	`date` text NOT NULL,
	`path` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text,
	`count` integer NOT NULL,
	PRIMARY KEY(`date`, `path`)
);
--> statement-breakpoint
CREATE TABLE `search_log` (
	`id` text PRIMARY KEY NOT NULL,
	`term` text NOT NULL,
	`no_results` integer NOT NULL,
	`date` text NOT NULL,
	`created_at` text NOT NULL
);

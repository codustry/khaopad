-- v3.3 analytics — events table for the typed track() SDK.
-- One row per canonical event; properties + context as JSON blobs so
-- plugin events don't need schema migrations. Design in
-- src/lib/server/analytics/events-schema.ts.

CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `properties_json` text DEFAULT '{}' NOT NULL,
  `context_json` text DEFAULT '{}' NOT NULL,
  `ts` text NOT NULL,
  `session_id` text NOT NULL,
  `user_id` text,
  `article_id` text,
  `product_id` text
);
--> statement-breakpoint
CREATE INDEX `events_name_ts_idx` ON `events` (`name`, `ts`);
--> statement-breakpoint
CREATE INDEX `events_session_ts_idx` ON `events` (`session_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `events_article_ts_idx` ON `events` (`article_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `events_product_ts_idx` ON `events` (`product_id`, `ts`);

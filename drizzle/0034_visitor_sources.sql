-- Visitor sources: where traffic comes from, aggregated per day.
--
-- Same counter discipline as `page_views`, one dimension wider. The
-- composite PK is the full dimension tuple and the only payload is a
-- count, so a landing UPSERTs into an existing row rather than
-- appending one.
--
-- The shape IS the privacy guarantee. There is no id, no session
-- column, and no timestamp finer than the UTC date, so a row says
-- "N landings matched this description that day" and cannot say who,
-- in what order, or whether N was one visitor N times or N visitors
-- once. Do not add a timestamp, session id, or IP column here: with
-- (time, referrer, path) on one row this table would reconstruct an
-- individual's journey, which is the thing it exists not to do.
--
-- `source`/`medium`/`campaign` are partly attacker-controlled
-- (utm_* query parameters), so they are normalised to a bounded
-- charset and length and bucketed to "other" before insert — see
-- src/lib/server/analytics/sources.ts. Without that a
-- `?utm_source=<random>` spray would grow this table without bound.
CREATE TABLE `visitor_sources` (
	`date` text NOT NULL,
	`channel` text NOT NULL,
	`source` text NOT NULL,
	`medium` text NOT NULL,
	`campaign` text NOT NULL,
	`path` text NOT NULL,
	`count` integer NOT NULL,
	PRIMARY KEY(`date`, `channel`, `source`, `medium`, `campaign`, `path`)
);
--> statement-breakpoint
-- Every admin read is `WHERE date >= ?` then a GROUP BY on one of the
-- dimensions; this covers the range scan.
CREATE INDEX `idx_visitor_sources_date` ON `visitor_sources` (`date`);

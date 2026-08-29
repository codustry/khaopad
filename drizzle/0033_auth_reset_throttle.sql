-- Password-reset email throttle: one send per account per 24 hours.
--
-- D1-backed rather than KV: production KV caches reads for >= 60s and is
-- eventually consistent between colos, so two requests in different edge
-- locations would both read "no prior send" and both send. D1 is strongly
-- consistent, which is what makes the atomic
-- `INSERT ... ON CONFLICT DO UPDATE ... WHERE expired` claim race-free.
-- See src/lib/server/auth/reset-throttle.ts.
--
-- `key` is a SHA-256 hex digest ("email:<hash>" / "ip:<hash>"), never a
-- plaintext address — this table must not become a list of who forgot
-- their password.
CREATE TABLE `auth_reset_throttle` (
  `key` text PRIMARY KEY NOT NULL,
  `last_sent_at` integer NOT NULL,
  `send_count` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
-- Supports pruning rows whose window has long expired.
CREATE INDEX `idx_auth_reset_throttle_last_sent` ON `auth_reset_throttle` (`last_sent_at`);

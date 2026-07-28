-- @khaopad/plugin-hello v0.1.0
-- Creates the hello_pings table used by the reference plugin.
-- Naming convention for plugin migrations: <NNNN>_plugin_<slug>_<desc>.sql
-- so wrangler d1 migrations apply runs them in the same numeric sequence
-- as core migrations. Plugin authors coordinate NNNN with the host repo
-- to avoid collisions (see docs/plugin-authoring.md).

CREATE TABLE `hello_pings` (
  `id` text PRIMARY KEY NOT NULL,
  `message` text NOT NULL,
  `created_at` text NOT NULL,
  `user_id` text,
  `count` integer DEFAULT 1 NOT NULL
);

-- Admin-managed secrets, encrypted at rest.
--
-- Values are `v1:<base64(iv || ciphertext)>` (AES-GCM, key derived from
-- BETTER_AUTH_SECRET via HKDF). Plaintext never reaches this table.
--
-- Separate from `site_settings` on purpose: that table is read wholesale
-- and its values flow into page data, which is exactly the path a payment
-- key must never travel.
CREATE TABLE `managed_secrets` (
  `key` text PRIMARY KEY NOT NULL,
  `value_encrypted` text NOT NULL,
  `updated_at` text NOT NULL,
  `updated_by` text
);

-- #143: the seeded privacy policy contained a literal `/[locale]/cookie-policy`
-- link — `[locale]` was template syntax that was never substituted, so the
-- stored markdown linked to the URL-encoded `/%5Blocale%5D/cookie-policy`,
-- a 404 on every install that ran the legal seed. This rewrites the link to
-- the row's own locale. Idempotent: rows without the literal are untouched,
-- and re-running matches nothing.
UPDATE page_localizations
SET body = replace(body, '(/[locale]/cookie-policy)', '(/' || locale || '/cookie-policy)')
WHERE body LIKE '%(/[locale]/cookie-policy)%';

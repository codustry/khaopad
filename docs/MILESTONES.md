# Milestones

Tracks what shipped in each milestone and what's pending. Updated every time a milestone (or release) PR merges into `main`.

## Shipped

### M1 — Scaffold & architecture

- SvelteKit 2 + Svelte 5 + Tailwind 4 + Cloudflare adapter.
- Route groups `(www)` / `(cms)` with subdomain routing in `hooks.server.ts`.
- Paraglide JS 2 wired up for UI strings (EN default, TH secondary).
- `ContentProvider` interface with D1 implementation.
- Platform guard (`locals.platform.env`) so local `pnpm dev` degrades gracefully without bindings.

### M2 — D1 migrations, seed, first-run setup

- Drizzle schema + migrations for articles, localizations, categories, tags, media, users/sessions.
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:migrate:remote` workflow.
- Seed script (`scripts/seed.ts`) with idempotent demo content.
- `pnpm setup` first-run wizard that prints post-install next steps.

### M3 — Auth & CMS article CRUD

- Better Auth (email/password, D1-backed sessions) with role hierarchy (super_admin > admin > editor > author).
- First-admin signup — `/cms/signup` only accepts the very first user, after which it 403s.
- CMS list/create/edit/delete pages for articles with per-locale (EN required, TH optional) forms.
- Permission helpers: `canEditArticle`, `canPublish`, `canDeleteArticle`.
- EN-only ASCII slugs shared across locales, auto-derived from EN title.

### M4 — Media library

- R2-backed upload/delete API (`/api/media/*`).
- CMS `/cms/media` page with drag-upload, alt-text, copy-ID, delete.
- `coverMediaId` picker in the article form with preview.
- `docs/MIGRATING.md` — guide for folding an existing SvelteKit project into Khao Pad.

### M5 — Categories & tags

- CMS `/cms/categories` and `/cms/tags` pages: list/create/edit/delete with inline editor and EN/TH localizations.
- `canManageTaxonomy` permission gate (editor+ can write, anyone authenticated can read).
- Category `<select>` + tag multi-checkbox picker inside the article form; persisted via `categoryId` / `tagIds` on `ArticleUpdateInput`.
- Public blog filters: `/blog?category=<slug>` and `/blog?tag=<slug>` with clear-filter banner and clickable taxonomy chips on each article card.
- Article cards on `/blog` now surface their category + tags.
- GitHub Actions `ci.yml` runs `svelte-check`, `eslint`, `prettier`, and `vite build` on every PR.

### M6 — Deploy pipeline

- `wrangler.toml` now defines `[env.staging]` and `[env.production]` with per-env D1 / R2 / KV bindings so state is never shared across envs.
- `.github/workflows/deploy.yml` rewritten as a four-stage pipeline: **gate → resolve-env → deploy → smoke-test**.
  - Push to `main` → auto-deploy to **staging**.
  - Push tag `v*.*.*` → deploy to **production**.
  - `workflow_dispatch` input → deploy to the chosen env manually.
- The `gate` job runs the same checks as `ci.yml` (svelte-check + lint + build) so PRs and deploys can't disagree.
- `deploy` attaches to a GitHub Environment of the same name — add required-reviewer protection on `production` under Settings → Environments to gate prod behind an approval.
- D1 migrations apply with `--env <target>` so each env's schema is bumped independently.
- `smoke-test` curls the public URL (from repo Variables `STAGING_PUBLIC_URL` / `PRODUCTION_PUBLIC_URL`) up to 6× with 10 s backoff; treats 2xx/3xx/503 as healthy.
- `docs/DEPLOYMENT.md` now documents the full promotion flow, required secrets/variables, and per-env provisioning steps.

### M7 — Editor UX

- New `$lib/components/editor/MarkdownEditor.svelte` drop-in replaces the bare article body `<textarea>` in both `new` and `[id]` routes for EN and TH.
- Toolbar: bold, italic, H1/H2, link, media-insert, bulleted/numbered lists, inline code, blockquote.
- Three view modes (Write / Split / Preview) — split shows live `marked`-rendered HTML in a `prose` pane next to the editor; `@tailwindcss/typography` plugin enabled via `@plugin` in `app.css`.
- Keyboard shortcuts: ⌘B (bold), ⌘I (italic), ⌘K (link).
- `MediaPicker` modal lazy-loads `GET /api/media`, renders a thumbnail grid, and inserts `![alt](/api/media/:id)` for images or `[name](/api/media/:id)` for other types at the cursor.
- Autosave: debounced write to `localStorage[khaopad:draft:article:<scope>:<field>]`; on re-open, compares against the seeded value and offers a restore banner if different. Cleared after a successful save via the parent's `use:enhance` callback.
- i18n: 22 new Paraglide keys (EN + TH) covering toolbar labels, modes, picker copy, and the parameterized draft-available banner.

### v1.1 — Path-prefix routing, shadcn reskin, scope tightening

A consolidation release: ship the architectural change everyone needs, modernize the admin shell, fix a class of D1 + Better Auth bugs, and cut the unimplemented "Mode B" GitHub backend that had been hanging around since M1.

**Routing**

- CMS moved from `cms.example.com` subdomain to `/cms/*` path prefix on the same host (#11). Unblocks Cloudflare workers.dev demos, removes `/etc/hosts` editing for local dev, lines up with how Sanity Studio / Strapi / KeystoneJS ship their admin panels.
- `subdomainHook` → `surfaceHook` in `hooks.server.ts`. `event.locals.surface` is the new property; `event.locals.subdomain` kept as a deprecated alias.
- `/` redirects to the visitor's preferred locale (`/en` or `/th`) via cookie / Accept-Language / default precedence (#13). Removes a stale pre-reskin home page that was orphaned at the bare root.
- Single-host wrangler config replaces the `www.` / `cms.` split: one DNS record, one route pattern, no zone gymnastics.

**Admin reskin (PR #12)**

- Hand-rolled collapsible sidebar with localStorage state, lucide icons, role-gated items (Users / Settings hidden from author/editor), active-route highlight that survives nested paths.
- Two-column auth pages on `/cms/login` and `/cms/signup` (brand panel + form on `lg+`, single column on mobile).
- Cookie-based locale toggle in the admin topbar (no URL change). The Paraglide strategy `["url","cookie","baseLocale"]` already does this — `/cms/*` has no `/en` or `/th` URL prefix to match, so the URL strategy falls through to cookie automatically.
- shadcn-style primitives in `$lib/components/ui/`: Button, Input, Label, Card (+ Header/Title/Description/Content/Footer), Separator, Badge, Avatar with initials fallback.
- oklch palette + IBM Plex Sans Thai. `.dark` block in `app.css` for a future dark-mode toggle.

**Auth resilience**

- D1 + Date-binding fix (#14). Better Auth's adapter passed JS `Date` objects directly to D1, which only accepts string/number/boolean/null/Uint8Array — every signup crashed with `D1_TYPE_ERROR`. The fix wraps the D1 driver in `createAuth` so `prepare(sql).bind(...args)` swaps Dates for ISO strings before Cloudflare's binding code sees them. (`databaseHooks` don't help here — Better Auth's transform layer runs after hooks and converts ISO strings _back_ to Dates if the field type is `"date"`.)
- `auth.api.signUpEmail` now receives `request.headers` so the auto-sign-in path has a request context for the session cookie write.
- `auth.api.getSession` is wrapped in try/catch in the auth hook — a malformed session cookie no longer turns every page into a 500.

**Scope tightening (PR #17)**

- Removed the never-shipped GitHub-backed "Mode B" content storage entirely (`src/lib/server/content/providers/github.ts`, `CONTENT_MODE` env var, `GITHUB_*` config knobs, `.github/workflows/content-sync.yml`). Doubled the bug surface for hypothetical users; broke at media (R2 isn't versioned); confused the product pitch. The `ContentProvider` interface stays as a seam for tests.
- Sidebar entries for `/cms/users` and `/cms/settings` removed (#16) — the routes were referenced but had no `+page.svelte`. Re-added in v1.2 (#20).

**Net effect:** ~500 lines deleted, 6 PRs merged (#11–#13, #14–#16, #17). README, ARCHITECTURE, CONTENT-MODEL, MIGRATING, CLAUDE.md all updated to match. Live demo at `khaopad-example.codustry.workers.dev` runs all of v1.1 end-to-end.

### v1.2 — User & settings management (PR #20)

Closes the two sidebar 404s left by v1.1. Pure UI work on top of infrastructure that was already in place: the `users` table from M3, the `site_settings` table from M2, and the `ContentProvider.getSettings`/`updateSettings` methods that have existed in the interface since day one.

**`/cms/users`** — list view with avatar, role badge, joined date.

- Inline per-row role change with a dropdown.
- Last-super-admin demotion blocked with a clear error.
- Plain admins can manage editors and authors but not other admins or super_admins.
- Hard-delete with confirm; sessions and accounts cascade via existing FK rules; articles authored by the user block the delete with a surfaced "reassign first" message instead of a 500.
- Cannot change your own role or delete yourself.
- Every role change and deletion writes an `audit_log` row (best-effort, swallowed if the table isn't available so it never fails the action).
- Invite-link card surfaces the existing `/cms/signup` flow as the MVP. A real token-based invite system is deferred to a later release.

**`/cms/settings`** — form for `siteName`, `defaultLocale`, `supportedLocales`, `cdnBaseUrl`. Validates `defaultLocale` is in `supportedLocales`; site name required; at least one locale required. Reads from + writes to the existing `site_settings` table via `ContentProvider`.

**Permission helper** — new `canManageUser(actor, target)` centralizes three rules (no self-management, super_admin protection, admin-can't-touch-admin). Both server actions and the UI use it, so the buttons that appear match the actions that succeed.

**Sidebar** — `/cms/users` and `/cms/settings` re-added to the "Admin" group, role-gated to `super_admin` and `admin`.

**i18n** — 38 new Paraglide keys (EN + TH) covering role labels, field labels, help text, error strings, invite-card copy.

### v1.3 — Token invitations + audit log + scheduled publishing (PR #24)

Three features in one PR — they share the audit-log infrastructure and the admin-shell layout, and shipping separately would create review churn.

**Token-based invitations** replaces the v1.2 placeholder card on `/cms/users`. New `invitations` table (Drizzle migration 0001) with `email`, `role`, `token`, `expiresAt`, `acceptedAt`. The token is a random base64url string (~128 bits of entropy); the URL itself is the bearer credential — presence + unconsumed + not-expired = valid. Helpers in `$lib/server/invitations/` cover create / find / consume (atomic via a where-clause guard on `acceptedAt IS NULL`, so a race between two browsers leaves exactly one winner) / revoke / list. The `/cms/users` page now has a real form: pick role, generate, copy with one click, see all outstanding invites, revoke any of them. `/cms/invite/[token]` is a full-bleed accept page with granular error states for invalid / consumed / expired tokens; on POST it runs Better Auth `signUpEmail`, sets the new user's role from the invitation, marks the invitation consumed, and redirects to `/cms/login?invited=1`. The `(cms)` layout gate was widened to allow `/cms/invite/*` without auth. Default TTL: 7 days.

**Audit-log viewer page** — extracted v1.2's `logAudit` helper to `$lib/server/audit/` with a typed `AuditAction` union covering every action the project logs (article.create / article.publish / category.update / tag.delete / media.delete / settings.update / invitation.create / invitation.accept / etc.). Best-effort writes — wrapped in try/catch so a missing table or transient D1 error never breaks the primary action the user cared about. Audit hooks added throughout: articles (create / update / publish / unpublish / delete), categories (create / update / delete), tags (create / update / delete), media (delete), settings (update), invitations (create / accept / revoke). The `/cms/audit` page (admin+ only) is paginated 50/page, shows actor avatar + name + email, action badge color-coded by verb (create/accept = primary, delete/revoke = destructive, else secondary), entity reference, timestamp, and an expandable JSON metadata block. Left-joins `users` so deleted-user rows still render gracefully. Sidebar gets a new "Audit log" entry in the Admin group.

**Scheduled publishing** — new `ArticleFilter.onlyPublished?: boolean` flag (default `false` so the CMS sees everything; public reads opt in). When set, the D1 provider adds `(publishedAt IS NULL OR publishedAt <= now)` to the WHERE clause — rows with no `publishedAt` slip through (treated as "publish immediately when status is 'published'"). Public blog index passes the flag; the `[slug]` page adds the same date check after the status check (a published article with a future `publishedAt` 404s). `ArticleForm.svelte` gets a `<input type="datetime-local">` next to the status select that pre-fills from `existing.publishedAt` and shows a "⏱ Scheduled for {when}" notice when status is published AND the date is in the future. Save action: explicit datetime from the form wins; otherwise the existing fallback rules apply (published → now, draft → null, archived → keep existing).

**i18n** — 22 new Paraglide keys (EN + TH).

### v1.4 — Full-text search (PR #26)

SQLite FTS5 virtual table over the per-locale `article_localizations` rows. Drizzle doesn't model virtual tables, so the migration (`drizzle/0002_fts5_articles.sql`) is hand-written: an `articles_fts` external-content table indexing `title`, `excerpt`, `body`, with `articleId` and `locale` carried as unindexed columns; tokenizer `unicode61 remove_diacritics 2` so Thai content tokenizes sensibly. Three `AFTER INSERT/UPDATE/DELETE` triggers on `article_localizations` keep the index in sync transparently — application code never touches FTS directly. A backfill at the end of the migration seeds the index from existing rows.

`ContentProvider.searchArticles(query, opts)` returns `SearchHit[]` joined against `articles` so the result respects status + scheduled publishing (`onlyPublished` flag is plumbed through). Query handling defaults to a quoted phrase match for safety, but lets advanced users pass FTS5 syntax (`AND` / `OR` / `NOT` / `NEAR` / parens / quotes / wildcards) by detecting those tokens and skipping the auto-quote. Public `/blog?q=` adds a search form to the index page; CMS articles list reuses the same flag.

**i18n** — 4 new `blog_search_*` keys (EN + TH).

### v1.5 — Content versioning (PR #27)

Per-article revision history with diff and restore. New `article_versions` table (Drizzle migration 0003) stores `articleId`, `locale`, monotonic `version` per `(articleId, locale)`, plus the snapshotted `title`, `excerpt`, `body`, `seoTitle`, `seoDescription`, `createdBy` (FK to `users`, `ON DELETE SET NULL` so deleted authors don't blow up the timeline), and `createdAt`. CASCADE from `articles` so deleting an article cleans up its history.

Snapshots are taken at the application layer in `D1ContentProvider` — only for the locales actually present in the create / update payload, never phantom snapshots for untouched locales. `actorId` is now part of `ArticleCreateInput` / `ArticleUpdateInput` so SQLite triggers don't have to guess at request context. New methods: `listArticleVersions`, `getArticleVersion`. LCS-via-DP line diff lives at `$lib/server/content/diff.ts` (no external dep — `diff-match-patch` was overkill for what's effectively `git diff`).

UI: `/cms/articles/[id]/history` is a timeline with batched actor lookups (one query for all `createdBy` IDs across the page). `/cms/articles/[id]/history/[versionId]` renders title / excerpt diffs as before/after blocks and the body as a per-line +/– list. Restore writes a fresh update through the normal path — which itself snapshots the now-replaced version — so undo is just "restore the previous version again." The action also writes an audit-log entry with `restoredFrom` / `restoredVersion` metadata.

**i18n** — 11 new `cms_history_*` keys (EN + TH).

## Pending

### Vision — what comes after v1.5

Through v1.5 we have a complete content layer: write, schedule, search, version. That's table stakes. The bigger thesis is that Khao Pad is the **driver of a non-ecommerce website** — meaning a site owner installs Khao Pad and gets the content layer **plus** the surrounding machinery a real website needs. The five pillars below organize that machinery; each pending milestone delivers a slice of one.

1. **Discoverability (SEO).** A site nobody finds is a site that doesn't exist. Per-page meta, sitemap, robots, structured data, hreflang, feeds, redirects.
2. **Insight (analytics).** Editors need to know what's working. Privacy-friendly page views, top content, search-term performance, editor metrics.
3. **Information architecture.** Articles aren't the whole site. Pages, navigation menus, hierarchy, asset organization.
4. **Performance & trust.** Responsive images, cache control, custom error pages, cookie consent.
5. **Engagement & growth.** Forms, newsletter, comments, webhooks, integrations.

The release plan below picks the 80/20 slice from each pillar in turn. v1.6 → v2.0 is roughly four months of focused work.

### v1.6 — SEO foundations

Closes the discoverability gap. `seoTitle` and `seoDescription` were stored on `article_localizations` but only the slug page rendered them; the home and blog index emitted minimal head tags and there was no canonical, OG, Twitter, hreflang, sitemap, robots, or feed surface anywhere. v1.6 makes Khao Pad a real-website SEO baseline — a deployed blog now scores Lighthouse SEO ≥90 out of the box.

**`<Seo>` component + `PageSeo` plumbing** — `src/lib/seo/index.ts` defines the per-page `PageSeo` record (title, description, canonical, locale, alternates, image, ogType, publishedTime, modifiedTime, robots, jsonLd[]) plus three JSON-LD builders (`articleJsonLd`, `breadcrumbJsonLd`, `websiteJsonLd`) and a `resolveOrigin(url, cdnBaseUrl)` helper. Each public page's `+page.server.ts` returns `seo: PageSeo`; the new `<Seo>` component (mounted in `(www)/+layout.svelte`) reads it via `$app/state` `page.data` and renders `<title>`, `<meta name="description">`, `<link rel="canonical">`, full Open Graph (`og:title` / `og:description` / `og:type` / `og:locale` / `og:url` / `og:image` / `og:site_name` / `article:published_time` / `article:modified_time`), Twitter Card tags, hreflang alternate links (with `x-default` pointing at EN), per-page JSON-LD entries as `<script type="application/ld+json">` blocks, and an RSS auto-discovery `<link rel="alternate">`.

**Sitemap** — `/sitemap.xml` is a sitemap index pointing at one `/sitemap-{locale}.xml` per supported locale. Each per-locale sitemap lists the locale home (`/{locale}`), the blog index (`/{locale}/blog`), and every published article in that locale (respecting scheduled publishing), each with `<loc>`, `<lastmod>` from `updatedAt`, and `<xhtml:link rel="alternate" hreflang>` siblings only for locales that actually have content. Cache-Control `public, max-age=300, s-maxage=3600`.

**robots.txt** — Per-environment. Reads `WORKERS_ENV` from `platform.env`. Production emits `User-agent: * / Allow: / / Disallow: /cms/ /api/ + Sitemap: …`; any non-production value emits `Disallow: /` so staging/preview never get indexed.

**RSS feed** — `/feed.xml` 302s to `/feed-{defaultLocale}.xml`. `/feed-{locale}.xml` returns RSS 2.0 (with the `content:encoded` namespace) for the 50 most recent published articles in that locale, full HTML body wrapped in `<![CDATA[…]]>` so readers can render without re-fetching. Includes `<atom:link rel="self">` for self-discovery.

**Slug redirects** — New `slug_redirects` table (Drizzle migration 0004): `oldSlug` (UNIQUE), `newSlug`, `articleId` (FK CASCADE from `articles`), `createdAt`. When `updateArticle({ slug })` actually changes a slug, the D1 provider writes a redirect row in the same call and re-points any chained redirects so an old link survives `a → b → c`. The public `/blog/[slug]` route, on miss, calls `resolveSlugRedirect(oldSlug)` and `throw redirect(301, …)` to the new canonical URL before throwing 404.

**JSON-LD** — Home page emits `WebSite` schema with a `SearchAction` pointing at `/{locale}/blog?q={search_term_string}`. Blog post pages emit full `Article` schema (headline, datePublished, dateModified, author, image, mainEntityOfPage, publisher).

**SEO inputs in the CMS** — The article edit form gets two new collapsible sections (one EN, one TH), each with `seo_title_*` and `seo_description_*` fields. Server-side actions for `new/+page.server.ts` and `[id]/+page.server.ts` parse the new fields and pass them into `localizations.{en,th}.seoTitle / seoDescription`. Failure-echo `values` blocks updated to round-trip the new fields through fail responses.

**SEO scoring hint** — Each SEO field shows a real-time soft verdict color-coded by tone: title 30–60 chars (green "good length"), title <30 or >60 (amber warning), missing override (muted "search engines will use the regular title"); description 70–160 (green), <70 or >160 (amber), missing (muted "will use the excerpt"). Falls back to `titleEn` / `excerptEn` when the override is empty so the score reflects what visitors actually see. Advisory only — never blocks save.

**i18n** — 12 new `cms_seo_*` keys (EN + TH).

### v1.7 — Pages, navigation, asset organization, and consent

A blog isn't a website. A website needs static pages (About, Contact, Privacy), a menu manager, asset folders, and (because we're starting to talk about analytics in v1.8) a real cookie-consent surface. Shipped in two PRs to keep reviews tractable: **v1.7a** = media folders + reusable blocks + cookie consent + legal templates; **v1.7b** = pages + navigation manager.

**Schema** — Drizzle migration 0005 lands all v1.7 tables in one shot (additive, no data migration): `media_folders`, `content_blocks` + `content_block_localizations`, `pages` + `page_localizations`, `navigation_menus` + `navigation_items`, plus a nullable `folder_id` column on `media`. v1.7a uses the first half; v1.7b activates the rest.

**Media folders** (v1.7a) — `media_folders` is a self-referencing tree (`parentId` nullable; null = root). `media.folderId` references it; `ON DELETE SET NULL` semantics implemented at the application layer (D1 doesn't model `SET NULL` for self-references the way we want). `MediaService` gains `listFolders` / `createFolder` / `renameFolder` / `deleteFolder` / `move`, and `list()` accepts a `{ folderId }` filter (`undefined` = all, `null` = root, `<id>` = that folder). `/cms/media` gets a left-tree sidebar with folder CRUD, an inline rename input, drag-to-move on every media tile, and an "uploading into folder X" hint when the URL is filtered. Existing rows live at the root with no migration.

**Reusable content blocks** (v1.7a) — `content_blocks` (id, key, label, timestamps) plus per-locale `content_block_localizations` (body). `ContentProvider` gets `listContentBlocks` / `getContentBlock` / `getContentBlockByKey` / `createContentBlock` / `updateContentBlock` / `deleteContentBlock`. The new `$lib/server/content/blocks.ts` exposes `expandBlocks(body, content, locale)` which scans a markdown body for `{{block:my-key}}` shortcodes, batches the lookups (one D1 round-trip per unique key, never N), and substitutes the per-locale body (falling back to EN, then to a `<!-- unknown block: x -->` HTML comment if the key doesn't exist). The blog `[slug]` route runs `expandBlocks` before `marked` so blocks render as authored. Cheap on the happy path: short-circuits when the body has no `{{block:` substring. New `/cms/blocks` admin page (editor+) with create/edit/delete and a copy-pasteable shortcode shown next to each block. Sidebar gets a Blocks entry under the Taxonomy group.

**Cookie consent** (v1.7a) — A first-party `khaopad_consent` cookie stores `{ ts, analytics, marketing, v: 1 }`. Functional cookies are always-on (the consent record itself, the locale cookie, the auth session) and not consentable. `$lib/consent` exposes `parseConsent` / `serializeConsent` / `isUndecided` / `emptyConsent`. The (www) layout server-side load reads the cookie once and surfaces it as `data.consent`; the layout mounts a `<CookieBanner>` component that only renders when undecided, supports Accept-all / Reject-non-essential / Customize, and POSTs to `/api/consent`. The endpoint sets `SameSite=Lax`, 1-year max-age, and is httpOnly=false (the banner needs to read it client-side). v1.8's analytics layer will gate page-view writes on `consent.analytics`.

**Legal templates** (v1.7a) — `static/legal-templates/{privacy-policy,cookie-policy}.md` plus a README explaining why we ship templates and not auto-generated text. They cover what a stock Khao Pad install actually does (Cloudflare hosting, Better Auth sessions, the `khaopad_consent` cookie) and have explicit `[Operator Legal Entity]` / `[Contact Email]` / `[Date]` placeholders for the operator to fill in. Once Pages land in v1.7b, a `pnpm seed:legal` script will turn each template into a Page row with the obvious placeholders pre-filled from `site_settings`. Until then they're documentation.

**Pages** (v1.7b) — New `pages` + `page_localizations` tables, routed at `(www)/[locale]/[...slug]` (catch-all so nested slugs like `/about/team` work). Per-locale title/body/seoTitle/seoDescription, three soft templates (`default` / `landing` / `legal`) that swap the public wrapper width and typography. Status (draft / published) and `publishedAt` honor the same scheduled-publishing semantics articles use. Reuses the markdown editor, the v1.6 `<Seo>` machinery, and v1.7a `expandBlocks` so `{{block:cta-newsletter}}` works in pages too. `/cms/pages` lists everything; `/cms/pages/new` and `/cms/pages/[id]` use a shared `PageForm.svelte` modeled on `ArticleForm`. The sitemap now lists every published page in each locale's per-locale sitemap, with hreflang siblings limited to locales that actually have content.

**Navigation manager** (v1.7b) — `/cms/navigation` admin (editor+). Two stock menus auto-bootstrapped on first load (`primary`, `footer`); admins can create more. Each item is one of `article` / `category` / `tag` / `page` / `custom`; the form swaps a target picker for a custom-URL field based on `kind`. Per-locale labels stored as JSON. Position is integer-based with up/down reorder buttons (true drag-drop trees deferred — v2.x). Public layout server load uses `loadNavigation()` to pre-fetch `primary` + `footer` and resolve every item to a render-ready `{ id, href, label }` for the active locale; the layout iterates that list with no DB work of its own. `navItemHref()` uses lookup maps so the resolution is O(1) per item.

**Legal page seeder** (v1.7b) — `seedLegalPages(content, authorId)` in `$lib/server/content/legal-seed.ts` reads embedded copies of the privacy and cookie policy markdown templates, prefills `[Site Name]` from `site_settings`, and creates draft Pages with the `legal` template. Idempotent: skips slugs that already exist. Wired into `/cms/pages` as a "Seed legal templates" button on the empty state — one click and you have draft Privacy + Cookie pages ready for the operator to fill in their entity, contact email, retention periods, and processors. Pages start as drafts; never auto-publish.

**i18n** — 18 keys in v1.7a + 23 keys in v1.7b (EN + TH).

### v1.8 — Analytics and insight

Privacy-friendly editor analytics. Closes the "what's working?" gap left after v1.7. Every counter is gated on the v1.7a cookie consent — visitors who opt out write nothing. Aggregated by `(date, path)` so a busy site stays bounded. **No IP, no user agent, no fingerprint stored.**

**Schema** — Drizzle migration 0006: `page_views` (composite PK on `(date, path)`, kind enum, optional `refId`, integer `count`) and `search_log` (anonymized `term` + `noResults` flag + `date`).

**Tracker** — `$lib/server/analytics/index.ts` exposes `trackView(db, opts, consent)` and `logSearch(db, term, noResults)`. View tracking does an UPSERT on the composite key — `INSERT … ON CONFLICT DO UPDATE SET count = count + 1` — so one row per day per path, atomic increments. Both functions are best-effort: a write failure never breaks the public page render. Tracking is instrumented on the home, blog index, blog slug, and the v1.7b page catch-all routes; the search log fires from `/blog?q=` whether or not analytics consent is given (search itself is functional, not analytics).

**`AnalyticsService`** — Read surface used by the dashboard + article edit page. Methods: `topPaths` / `topArticles` / `topSearchTerms` / `topNoResultTerms` / `sparkline(path, days)` / `totalViews(path, days)`. All scoped to the last `days` (default 30) so the queries stay fast. The sparkline densifies the result so empty days return `count = 0` and the chart line stays continuous.

**Dashboard tiles** — Two new cards (admin / editor / author all see them — the data is non-sensitive aggregate). "Top articles (30 days)" resolves `refId → article` once at load time so the list shows real titles, not raw paths. "Search insights" splits into two stacks: most-searched terms (with click-through to `/blog?q=…`) and searches with no results (the content-gap list). Both surface a "no data yet" empty state that explains how to seed counters.

**Per-article sparkline** — Article edit page (`/cms/articles/[id]`) loads a 30-day series for the article's slug across every supported locale, merges them by date, and renders a tiny SVG sparkline above the form alongside a 30-day total. Runs lazily — the component returns nothing if there are no views yet, so a fresh article doesn't get a flat-line chart. All best-effort: the form still loads if analytics is unavailable.

**Cloudflare Web Analytics opt-in** — New `cfaToken` field in `/cms/settings`. When set AND the visitor consented to analytics, the (www) layout injects the official `https://static.cloudflareinsights.com/beacon.min.js` script with the operator's site token. Off by default; the first-party D1 counter runs regardless of this setting. No tracking code unless both conditions are met.

**i18n** — 9 new keys (EN + TH).

### v1.9 — Performance and trust

(Cookie consent already shipped in v1.7a — that bullet moved to where it actually belongs.)

**Responsive images** — `<ResponsiveImage>` component at `$lib/components/media/ResponsiveImage.svelte` emits an `<img>` with a 3-width `srcset` (`640w`, `1024w`, `1920w`) using Cloudflare's URL-based image transform format `/cdn-cgi/image/width=W,format=auto,quality=85<source>`. When the zone has Cloudflare Images enabled, requests are intercepted at the edge and the right size is served (WebP/AVIF when supported). When the zone doesn't have it enabled, Cloudflare passes the URL through unchanged → the raw R2 URL serves. Same component, both deployments. The article cover image swaps over from the bare `<img>` tag; future sites that paste the component into pages get responsive images for free.

**Cache control** — New `cacheHook` in `src/hooks.server.ts` (last in the sequence). Pure pass-through: it inspects the response, and if no `cache-control` is already set, applies a sensible default by path. `/cms/*` and `/api/auth/*` and `/api/consent` get `no-store`. `/api/media/*` gets `public, max-age=86400, swr=604800` (R2 blobs are immutable per id). `/api/*` defaults to `no-store`. Article slug pages get `public, max-age=120, s-maxage=600, swr=86400`. Everything else gets `public, max-age=60, s-maxage=300, swr=86400`. Per-route handlers that already set their own header (`/sitemap.xml`, `/robots.txt`, `/feed-{locale}.xml`, `/api/health`) keep their explicit values.

**Custom 404 / 500** — `(www)/+error.svelte` with the same paypers visual language as the rest of the public surface. Big 404/500 number in display font, friendly title + subtitle from i18n, search box (404 only — posts to `/blog?q=` so it flows through v1.4 FTS), back-home + browse-blog buttons. `<meta name="robots" content="noindex,nofollow">` so error pages never get indexed.

**Health endpoint** — `/api/health` (no auth required). Returns `{ ok, timestamp, bindings: { d1, r2, kv }, environment? }` with a per-binding `{ ok, latencyMs }` plus `error` string on failure. Always 200 even when a binding is broken — uptime monitors watching for HTTP 200 still see the JSON-level failure. Returns 503 only when the platform shim itself is missing (local dev without wrangler). Cache-Control is explicitly `no-store`.

**i18n** — 7 new `error_*` keys (EN + TH).

### v2.0 — Engagement and growth (in progress)

Shipping in four PRs grouped by theme. **a** + **b** done, **c** + **d** to follow.

**v2.0a — Forms (shipped)** — Drizzle migration 0007: `forms` (key UNIQUE, fields-as-JSON, `enabled` flag, per-locale success messages) and `form_submissions` (data JSON, ip_hash 16-char truncated SHA-256 — never raw IP, status enum new/read/spam/archived, note). Public `POST /api/forms/[key]` accepts multipart/url-encoded with honeypot field `_hp` and per-IP rate limit (3/minute). 410 when form disabled, 429 on rate-limit. CMS at `/cms/forms` with editor (add/reorder/delete fields of kind text/email/textarea/checkbox, per-field name + label + required toggle) and an embedded submissions inbox with mark-as / delete actions. New `form.{create,update,delete,submit}` audit actions.

**v2.0b — Newsletter (shipped, fully optional)** — Drizzle migration 0008: `subscribers` (email UNIQUE, locale, token UNIQUE, confirmedAt, unsubscribedAt, source). Optional everywhere: when no email provider is configured, public signups go single-opt-in (subscribers immediately confirmed) — clearly documented. When the operator sets a Resend API key + sender address in `/cms/settings → Newsletter`, public signups become double-opt-in: a confirmation email goes out via Resend, subscriber is "active" only after they click the link. Public endpoints: `POST /api/newsletter/subscribe` (form-data with email + locale, honeypot `_hp`, per-IP rate-limit-ready via the v2.0a hashIp helper), `GET /api/newsletter/confirm?token=...` (idempotent click target → 302 to localized home with `?newsletter=confirmed`), `GET /api/newsletter/unsubscribe?token=...` (one-click, no interstitial — GDPR/CAN-SPAM compliance). Admin endpoint `POST /api/newsletter/send-digest?days=7&dryRun=1` iterates active subscribers, groups by locale, picks the last week's published articles per locale, sends one email per subscriber via Resend. CMS `/cms/subscribers` (admin+ only) lists subscribers with status badge (pending/active/unsubscribed), exposes manual "Send digest now" + dry-run button when a provider is configured, shows a clear "no provider configured" banner with a link to settings when not. New `newsletter.{subscribe,confirm,unsubscribe,delete,digest_sent}` audit actions. Cron-trigger wiring deferred to operator's wrangler.toml.

**v2.0c — Comments (shipped, dual-toggle)** — Drizzle migration 0009: `comments` (id, articleId FK CASCADE, parentId for forward-compat threading, authorName, authorEmail, body plain-text, status enum pending/approved/spam/archived, ipHash 16-char SHA-256 truncate, submittedAt, moderatedBy + moderatedAt) + new `articles.commentsMode` column (`inherit` | `on` | `off`, defaults to `inherit`). Two-layer policy: a site-wide `commentsEnabled` setting in `/cms/settings → Comments` (defaults to **off** so a fresh deploy never accidentally exposes a comment form) AND a per-article radio (`Inherit` / `On` / `Off`) on the article form. The `commentsAllowedForArticle()` helper is a one-line truth table both the public render and the POST endpoint consult. Public `POST /api/comments` (form-data: `article_id`, `name`, `email`, `body`, honeypot `_hp`) reuses the v2.0a hashIp + rate-limit pattern (3 / minute per ip-hash per article). Returns 410 when commentsAllowed=false, 429 when rate-limited. Approved comments render below the article body in a generic `<CommentSection>` (oldest → newest, plain-text only — no markdown/HTML to keep the XSS surface minimal). The submission form posts via `fetch()` so the page doesn't reload; success message says "awaiting moderation". CMS `/cms/comments` (editor+) is a moderation queue with status tabs (pending/approved/spam/archived), batched-resolved article titles for each row, masked email display (`a***@e***.com`), mark-as buttons, mailto reply, and a sidebar entry. The pending count drives a future sidebar badge (read once on dashboard load). New `comment.{create,approve,spam,archive,delete}` audit actions. **Out of scope (deliberate):** threaded replies (parentId is forward-compat schema only — UI is flat), comments on Pages (Pages are typically static), Akismet/ML spam filtering (honeypot+rate-limit is the v2.0 floor), email notifications to commenters when approved.

**v2.0d — Webhooks + Public REST API (shipped)** — Drizzle migration 0010: `webhooks` (id, label, url, secret 48-char nanoid, events JSON, enabled, audit fields), `webhook_deliveries` (per-attempt log: webhookId CASCADE, event, payload, responseStatus, responseExcerpt 256 chars, durationMs, attempt, nextAttemptAt, ok), `api_keys` (id, label, keyHash UNIQUE — SHA-256 hex of raw key, prefix kp_live_xxxx kept for display, scopes JSON, expiresAt, revokedAt, lastUsedAt, audit fields). New `WebhookEvent` union: `article.{publish,unpublish,delete}` / `comment.approve` / `form.submit` / `subscriber.confirm`. Dispatcher in `$lib/server/webhooks/`: HMAC-SHA256 signs body using webhook's secret, sends `X-Khaopad-Signature: sha256=<hex>` + `X-Khaopad-Event` + `X-Khaopad-Delivery` UUID headers, 5s timeout, 3 inline attempts with 250ms / 1500ms backoff. Best-effort writes a `webhook_deliveries` row for every attempt — operator debugs from CMS. `dispatchEvent()` is fire-and-forget at the call site; the originating action returns immediately. Wired into article publish/unpublish/delete (article edit + togglePublish), comment approve (single-target — spam/archive don't fire), form submit (public POST endpoint), and subscriber confirm (the email click target). Public REST API at `/api/public/articles` (paginated, locale filter), `/api/public/articles/[slug]`, `/api/public/categories`, `/api/public/tags`, `/api/public/pages`. Bearer auth via `Authorization: Bearer kp_live_…` header; SHA-256 hash lookup against `api_keys.keyHash` so a leaked DB row can't authenticate. Per-key scopes: `articles:read`, `categories:read`, `tags:read`, `pages:read`, or `*:read` for the read-everything bundle. Hard-revoked keys + expired keys return null (401). `lastUsedAt` is bumped fire-and-forget on every successful auth so the operator can spot stale keys. `kp_live_` prefix is recognizable to GitHub secret scanning. Two new CMS routes (`/cms/webhooks` + `/cms/api-keys`), both admin+ gated; the api-keys page surfaces the raw key ONCE on create with a clear "won't be shown again" warning + copy button. New `settings.update` audit rows tag `kind: webhook.create` / `webhook.update` / `webhook.rotate_secret` / `webhook.delete` / `api_key.create` / `api_key.revoke` / `api_key.delete`.

### Backlog — bigger ideas, not committed

These are real, but each is large enough to deserve its own design pass. Listed for transparency, not commitment.

- **OAuth providers** (Google, GitHub) for multi-admin sites that don't want to manage passwords.
- **Block-based editor** — replace the markdown body with a Tiptap or ProseMirror tree of blocks (hero, callout, gallery, embed). Loses the "everything is markdown" simplicity; gains rich layout. Big call.
- **AI-assisted authoring** — outline generation, alt-text suggestion, SEO-description writing, machine-translation for the EN→TH gap. Requires a model binding choice (Workers AI? OpenAI?).
- **Multi-site / workspaces** — one Khao Pad instance hosting multiple independent sites. Schema isolation via a `siteId` column on every table.
- **A/B testing** — per-page hero variants with a randomized 50/50 cookie. Needs the analytics layer (v1.8) as a prerequisite.
- **Member-only content** — gated articles behind a paid subscription via Stripe. Shifts Khao Pad toward Substack territory; explicit non-goal for now.

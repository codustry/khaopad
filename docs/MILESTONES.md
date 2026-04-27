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

## Pending

### v1.3+ — Future ideas (not committed)

- OAuth providers (Google, GitHub) for multi-admin sites that don't want to manage passwords.
- Token-based user invitations — replace the v1.2 "share /cms/signup" placeholder with one-shot signed links + role assignment on accept.
- Audit-log viewer page — write hooks already exist for user changes; needs UI + write hooks for article/category/tag actions.
- Content versioning / diff view per article.
- Scheduled publishing (set `publishedAt` in the future, public site respects it).
- Full-text search via D1 FTS5 or KV-indexed.

# Milestones

Tracks what shipped in each milestone and what is pending. Updated every time a milestone PR merges into `main`.

## Shipped

### M1 — Scaffold & architecture

- SvelteKit 2 + Svelte 5 + Tailwind 4 + Cloudflare adapter.
- Route groups `(www)` / `(cms)` with subdomain routing in `hooks.server.ts`.
- Paraglide JS 2 wired up for UI strings (EN default, TH secondary).
- `ContentProvider` interface with D1 + stub GitHub implementations.
- Platform guard (`locals.platform.env`) so local `pnpm dev` degrades gracefully without bindings.

### M2 — D1 migrations, seed, first-run setup

- Drizzle schema + migrations for articles, localizations, categories, tags, media, users/sessions.
- `pnpm db:generate` / `pnpm db:migrate` / `pnpm db:migrate:remote` workflow.
- Seed script (`scripts/seed.ts`) with idempotent demo content.
- `pnpm setup` first-run wizard that prints post-install next steps.

### M3 — Auth & CMS article CRUD

- Better Auth (email/password, D1-backed sessions) with role hierarchy (super_admin > admin > editor > author).
- First-admin signup — `/register` only accepts the very first user, after which it 403s.
- CMS list/create/edit/delete pages for articles with per-locale (EN required, TH optional) forms.
- Permission helpers: `canEditArticle`, `canPublish`, `canDeleteArticle`.
- EN-only ASCII slugs shared across locales, auto-derived from EN title.

### M4 — Media library

- R2-backed upload/delete API (`/api/media/*`).
- CMS `/media` page with drag-upload, alt-text, copy-ID, delete.
- `coverMediaId` picker in the article form with preview.
- `docs/MIGRATING.md` — guide for folding an existing SvelteKit project into Khao Pad.

### M5 — Categories & tags

- CMS `/categories` and `/tags` pages: list/create/edit/delete with inline editor and EN/TH localizations.
- `canManageTaxonomy` permission gate (editor+ can write, anyone authenticated can read).
- Category `<select>` + tag multi-checkbox picker inside the article form; persisted via `categoryId` / `tagIds` on `ArticleUpdateInput`.
- Public blog filters: `/blog?category=<slug>` and `/blog?tag=<slug>` with clear-filter banner and clickable taxonomy chips on each article card.
- Article cards on `/blog` now surface their category + tags.
- GitHub Actions `ci.yml` runs `svelte-check`, `eslint`, `prettier`, and `vite build` on every PR.
- `updateTag` added to `ContentProvider` (and stubbed in GitHub provider) so categories and tags now share a symmetric surface.

### M6 — Deploy pipeline (this milestone)

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

### M7 — Editor UX (this milestone)

- New `$lib/components/editor/MarkdownEditor.svelte` drop-in replaces the bare article body `<textarea>` in both `new` and `[id]` routes for EN and TH.
- Toolbar: bold, italic, H1/H2, link, media-insert, bulleted/numbered lists, inline code, blockquote.
- Three view modes (Write / Split / Preview) — split shows live `marked`-rendered HTML in a `prose` pane next to the editor; `@tailwindcss/typography` plugin enabled via `@plugin` in `app.css`.
- Keyboard shortcuts: ⌘B (bold), ⌘I (italic), ⌘K (link).
- `MediaPicker` modal lazy-loads `GET /api/media`, renders a thumbnail grid, and inserts `![alt](/api/media/:id)` for images or `[name](/api/media/:id)` for other types at the cursor.
- Autosave: debounced write to `localStorage[khaopad:draft:article:<scope>:<field>]`; on re-open, compares against the seeded value and offers a restore banner if different. Cleared after a successful save via the parent's `use:enhance` callback.
- i18n: 22 new Paraglide keys (EN + TH) covering toolbar labels, modes, picker copy, and the parameterized draft-available banner.

## Pending

### v1.1+

- GitHub content provider (Mode A) + migration CLI (GitHub → D1).
- OAuth providers (Google, GitHub).
- Audit trail, content versioning, scheduled publishing.
- Full-text search; plugin system; multi-site.

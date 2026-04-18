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

### M5 — Categories & tags (this milestone)

- CMS `/categories` and `/tags` pages: list/create/edit/delete with inline editor and EN/TH localizations.
- `canManageTaxonomy` permission gate (editor+ can write, anyone authenticated can read).
- Category `<select>` + tag multi-checkbox picker inside the article form; persisted via `categoryId` / `tagIds` on `ArticleUpdateInput`.
- Public blog filters: `/blog?category=<slug>` and `/blog?tag=<slug>` with clear-filter banner and clickable taxonomy chips on each article card.
- Article cards on `/blog` now surface their category + tags.
- GitHub Actions `ci.yml` runs `svelte-check`, `eslint`, `prettier`, and `vite build` on every PR.
- `updateTag` added to `ContentProvider` (and stubbed in GitHub provider) so categories and tags now share a symmetric surface.

## Pending

### M6 — Deploy pipeline

- GitHub Actions `deploy.yml` for staging and production environments.
- Wrangler secrets + environment promotion flow.
- Smoke tests against the deployed worker.

### M7 — Editor UX

- Markdown editor with syntax highlighting and live preview.
- Inline image picker (pull from media library).
- Autosave drafts.

### v1.1+

- GitHub content provider (Mode A) + migration CLI (GitHub → D1).
- OAuth providers (Google, GitHub).
- Audit trail, content versioning, scheduled publishing.
- Full-text search; plugin system; multi-site.

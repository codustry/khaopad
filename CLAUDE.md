# Khao Pad (ข้าวผัด) — Project Guide

## What is this?

A modular CMS built with SvelteKit for Cloudflare. One repo, two subdomains:
- `www.example.com` — public website (SSR)
- `cms.example.com` — admin panel (authenticated)

## Tech stack

- **Framework**: SvelteKit 2 + Svelte 5
- **Styling**: Tailwind CSS 4 + shadcn/ui (bits-ui)
- **Database**: Cloudflare D1 via Drizzle ORM
- **Media**: Cloudflare R2
- **Cache**: Cloudflare KV
- **Auth**: Better Auth (email/password, D1-backed sessions)
- **Deployment**: Cloudflare Workers via `wrangler`

## Architecture

- Single SvelteKit app with route groups: `(www)` for public, `(cms)` for admin
- Subdomain routing via `hooks.server.ts`
- Content storage abstraction (`ContentProvider` interface) supports D1 mode (now) and GitHub mode (future)
- Media always stored in R2, metadata in D1

## Key directories

- `src/lib/server/content/` — Content provider interface, D1 provider, Drizzle schema
- `src/lib/server/auth/` — Better Auth setup, permissions
- `src/lib/server/media/` — R2 media service
- `src/lib/i18n/` — Locale helpers
- `src/routes/(www)/` — Public site routes
- `src/routes/(cms)/` — CMS admin routes
- `src/routes/api/auth/` — Auth API endpoints
- `drizzle/` — D1 migration files

## Commands

```bash
pnpm dev              # Local dev server
pnpm build            # Build for production
pnpm db:generate      # Generate D1 migration from schema changes
pnpm db:migrate       # Apply migrations locally
pnpm db:migrate:remote # Apply migrations to production D1
pnpm deploy           # Build + deploy to Cloudflare Workers
```

## Content model

- Articles have shared slug/media across languages, separate markdown per locale (TH/EN)
- Localizations stored in separate tables (`article_localizations`, `category_localizations`, etc.)
- Roles: super_admin > admin > editor > author

## Important patterns

- All IDs use `nanoid()`
- Dates stored as ISO strings in D1 (SQLite text)
- Content provider is injected into `locals` via hooks
- Auth guard is in `(cms)/+layout.server.ts`
- Route access control is enforced in `hooks.server.ts` (subdomain check)

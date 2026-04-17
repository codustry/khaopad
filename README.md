# Khao Pad (ข้าวผัด)

**A modular CMS for Cloudflare** — lightweight, multilingual, and built for Thai software houses.

> ข้าวผัด = Fried rice. Everyone wants something slightly different, but in the end it's the same core dish — just with different sauces and ingredients.

## Why Khao Pad?

We kept running into the same CMS problem:

| Solution           | Problem                                                                             |
| ------------------ | ----------------------------------------------------------------------------------- |
| Supabase           | Great ecosystem, but $25/mo is heavy for small sites when Cloudflare is nearly free |
| Self-hosted Strapi | Too large, too many resources, needs separate deployment                            |
| Pages CMS          | Great UI, but doesn't scale to D1/R2 when you need it                               |

Khao Pad fills the gap: **start lightweight, scale when needed, stay on Cloudflare.**

## Features

- **One repo, two subdomains** — `www` for public site, `cms` for admin panel
- **Multilingual first** — shared slug and media, separate content per language (TH/EN)
- **Pluggable storage** — D1 mode now, GitHub file-based mode later
- **Cloudflare-native** — D1 database, R2 media, KV caching, Workers deployment
- **Better Auth** — email/password auth with role-based access (Super Admin, Admin, Editor, Author)
- **Paraglide JS** — compile-time i18n with type-safe translations via inlang
- **SvelteKit + Tailwind + shadcn/ui** — modern, fast, beautiful

## Architecture

```
┌──────────────────────────────────────────┐
│            Single SvelteKit App           │
│                                           │
│  hooks.server.ts (subdomain routing)      │
│                                           │
│  ┌─────────────┐  ┌───────────────────┐   │
│  │  (www)/      │  │  (cms)/           │   │
│  │  Public site │  │  Admin panel      │   │
│  └─────────────┘  └───────────────────┘   │
│                                           │
│  ┌──────────────────────────────────────┐ │
│  │  ContentProvider (interface)          │ │
│  │  ├── D1ContentProvider (active)      │ │
│  │  └── GitHubContentProvider (planned) │ │
│  └──────────────────────────────────────┘ │
│                                           │
│  Cloudflare: D1 · R2 · KV · Workers      │
└──────────────────────────────────────────┘
```

## Tech Stack

- [SvelteKit](https://svelte.dev) — Full-stack framework
- [Tailwind CSS](https://tailwindcss.com) — Utility-first styling
- [shadcn/ui (svelte)](https://shadcn-svelte.com) — Component library
- [Drizzle ORM](https://orm.drizzle.team) — Type-safe SQL for D1
- [Better Auth](https://better-auth.com) — Authentication
- [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) — Compile-time i18n (inlang)
- [Cloudflare Workers](https://workers.cloudflare.com) — Edge deployment
- [Cloudflare D1](https://developers.cloudflare.com/d1/) — SQLite database
- [Cloudflare R2](https://developers.cloudflare.com/r2/) — Object storage
- [Cloudflare KV](https://developers.cloudflare.com/kv/) — Key-value cache

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (for local tooling parity with CI)
- [pnpm](https://pnpm.io/) 9+
- Cloudflare account
- Wrangler CLI (`pnpm add -g wrangler`)

### Setup

```bash
# Clone
git clone https://github.com/codustry/khaopad.git
cd khaopad

# Install dependencies
pnpm install

# Copy environment variables
cp .env.example .env
# Edit .env with your secrets

# Create Cloudflare resources
wrangler d1 create khaopad-db
wrangler r2 bucket create khaopad-media
wrangler kv namespace create CONTENT_CACHE

# Update wrangler.toml with the IDs from above

# Run database migrations
pnpm run db:migrate

# Start dev server
pnpm dev
```

### Local Development

For subdomain testing locally, add to `/etc/hosts`:

```
127.0.0.1 www.khaopad.local cms.khaopad.local
```

Then access:

- Public site: `http://www.khaopad.local:5173`
- CMS admin: `http://cms.khaopad.local:5173`

## Content Model

```
Article (shared)
├── id, slug (English ASCII), status, coverMedia, category, tags, author
├── Localization (EN) ← required, slug is derived from this title
│   └── title, excerpt, body (markdown), SEO fields
└── Localization (TH)
    └── title, excerpt, body (markdown), SEO fields
```

Articles share the same slug and media across languages. Only the text content differs per locale.

**Slugs are always English ASCII** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`) and auto-generated from the English title via `slugify()`. The same slug serves every locale — there is no per-language slug.

## Storage Modes

### Mode A: Cloudflare D1 (default)

Content metadata and article records stored in D1 (SQLite). Best for most projects.

### Mode B: GitHub-backed (planned)

Content stored as markdown/JSON files in the repo. Good for the smallest/simplest sites. Set `CONTENT_MODE=github` in `wrangler.toml`.

Both modes share the same `ContentProvider` interface — your CMS code doesn't change.

## User Roles

| Role        | Create | Edit Own | Edit Any | Publish | Delete Any | Manage Users/Settings |
| ----------- | :----: | :------: | :------: | :-----: | :--------: | :-------------------: |
| Author      |  yes   |   yes    |    -     |    -    |     -      |           -           |
| Editor      |  yes   |   yes    |   yes    |   yes   |     -      |           -           |
| Admin       |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |
| Super Admin |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |

## Deployment

Deploys automatically to Cloudflare Workers on push to `main` via GitHub Actions.

Required GitHub Secrets (sourced from the **codustry organization** secrets — already configured, inherited automatically by all repos):

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Required Cloudflare Secrets (set via `wrangler secret put`):

- `BETTER_AUTH_SECRET`

## Scripts

| Command                  | Description                            |
| ------------------------ | -------------------------------------- |
| `pnpm dev`               | Start local dev server                 |
| `pnpm build`             | Build for production                   |
| `pnpm db:generate`       | Generate migration from schema changes |
| `pnpm db:migrate`        | Apply migrations locally               |
| `pnpm db:migrate:remote` | Apply migrations to production D1      |
| `pnpm deploy`            | Build and deploy to Cloudflare Workers |

## Roadmap

### v1.0 (MVP)

- [x] Project scaffold and architecture
- [ ] D1 content provider (articles, categories, tags)
- [ ] Better Auth integration
- [ ] CMS admin panel (article CRUD, media library)
- [ ] Public blog with multilingual routing
- [ ] GitHub Actions deployment

### v1.1

- [ ] GitHub content provider (Mode A)
- [ ] Migration CLI (GitHub → D1)
- [ ] OAuth providers (Google, GitHub)
- [ ] Rich media management

### v2.0

- [ ] Custom content types (pages, FAQs)
- [ ] Audit trail
- [ ] Content versioning
- [ ] Scheduled publishing
- [ ] Full-text search

### v3.0

- [ ] Plugin system
- [ ] Multi-site support
- [ ] White-label CMS
- [ ] API-first headless mode

## License

MIT — Codustry

---

Built with 🍳 by [Codustry](https://codustry.com)

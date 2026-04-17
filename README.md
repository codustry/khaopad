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

## Using Khao Pad in your project

Khao Pad is a **template**, not a hosted service. Fork or clone this repo, provision your own Cloudflare resources, and deploy to your own account. Every project gets its own isolated D1 database, R2 bucket, and KV namespace — nothing is shared between installations.

### Prerequisites

- [Node.js](https://nodejs.org/) 22+ (for local tooling parity with CI)
- [pnpm](https://pnpm.io/) 9+
- Cloudflare account
- Wrangler CLI (`pnpm add -g wrangler`) and `wrangler login`

### Setup

```bash
# 1. Fork on GitHub (or clone directly)
git clone https://github.com/your-org/your-project.git
cd your-project

# 2. Install dependencies
pnpm install

# 3. Provision Cloudflare resources (D1 + R2 + KV) in one command
pnpm setup
# Prints the database_id and KV id you need. Paste them into wrangler.toml
# (replace LOCAL_DB_ID and LOCAL_KV_ID).

# 4. Set your Better Auth secret (any long random string)
wrangler secret put BETTER_AUTH_SECRET

# 5. Apply migrations and seed sample data into local D1
pnpm db:migrate
pnpm db:seed

# 6. Start the dev server (Wrangler, uses local D1/R2/KV simulators)
pnpm wrangler:dev
# or plain Vite without bindings (shows a friendly 503 "Configuration required")
pnpm dev
```

### How D1, R2, and KV connect to Khao Pad

Cloudflare bindings are **not auto-generated** — they must be provisioned once per project, then bound to your Worker by ID in `wrangler.toml`:

| Binding         | Resource     | Created by                         | Referenced in `wrangler.toml` |
| --------------- | ------------ | ---------------------------------- | ----------------------------- |
| `DB`            | D1 database  | `wrangler d1 create <name>`        | `database_id`                 |
| `MEDIA_BUCKET`  | R2 bucket    | `wrangler r2 bucket create <name>` | `bucket_name`                 |
| `CONTENT_CACHE` | KV namespace | `wrangler kv namespace create`     | `id`                          |

`pnpm setup` runs all three for you and prints the IDs to paste in. Your code never hardcodes account IDs or credentials — Cloudflare injects the bindings into `platform.env` at runtime.

For **local dev** with `pnpm wrangler:dev`, Wrangler spins up local simulators for D1/R2/KV automatically — the production IDs only matter when you deploy with `pnpm deploy`.

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

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

- **One repo, one host, two surfaces** — public site at `/`, admin CMS at `/cms/*`
- **Multilingual first** — shared slug and media, separate content per language (TH/EN)
- **D1 + R2 storage** — articles in D1 (SQLite at the edge), media in R2, KV for caching. Sub-10ms reads from anywhere
- **Cloudflare-native** — D1 database, R2 media, KV caching, Workers deployment
- **Better Auth** — email/password auth with role-based access (Super Admin, Admin, Editor, Author)
- **Paraglide JS** — compile-time i18n with type-safe translations via inlang
- **SvelteKit + Tailwind + shadcn/ui** — modern, fast, beautiful

## Architecture

```
┌──────────────────────────────────────────┐
│            Single SvelteKit App           │
│                                           │
│  hooks.server.ts (path-based surface)     │
│                                           │
│  /*           → (www)/  public site       │
│  /cms/*       → (cms)/  admin panel       │
│  /api/auth/*  → Better Auth handler       │
│                                           │
│  ContentProvider → D1ContentProvider      │
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

```bash
pnpm dev
```

- Public site: `http://localhost:5173`
- CMS admin: `http://localhost:5173/cms`
- First admin signup: `http://localhost:5173/cms/signup` (one-shot, before any user exists)
- Login: `http://localhost:5173/cms/login`

No `/etc/hosts` editing needed — both surfaces share one host. Locale switches via `/en/blog` ↔ `/th/blog` on the public side; the CMS reads locale from a cookie so admin URLs stay clean.

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

## Storage

Articles, categories, tags, and user/session data live in **Cloudflare D1** (SQLite at the edge — sub-10ms reads worldwide). Media files (uploads, cover images) live in **Cloudflare R2**. Cached read-throughs sit in **KV**.

Database access is mediated by a `ContentProvider` interface (`src/lib/server/content/types.ts`). The default and only shipped implementation is D1-backed; the interface is kept so test fixtures or alternate backends can slot in without rewriting call sites.

## User Roles

| Role        | Create | Edit Own | Edit Any | Publish | Delete Any | Manage Users/Settings |
| ----------- | :----: | :------: | :------: | :-----: | :--------: | :-------------------: |
| Author      |  yes   |   yes    |    -     |    -    |     -      |           -           |
| Editor      |  yes   |   yes    |   yes    |   yes   |     -      |           -           |
| Admin       |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |
| Super Admin |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |

## Deployment

Deploys automatically to Cloudflare Workers on push to `main` via GitHub Actions (`.github/workflows/deploy.yml`). The workflow runs `pnpm install --frozen-lockfile`, `pnpm build`, applies pending D1 migrations to the remote database, then deploys the Worker.

### Config reference

Khao Pad reads everything through Cloudflare's binding/env model. There are four layers — know which goes where:

| Layer                  | Where it lives                          | Scope       | Example                       |
| ---------------------- | --------------------------------------- | ----------- | ----------------------------- |
| Bindings               | `wrangler.toml` `[[d1_databases]]` etc. | Per project | `DB`, `MEDIA_BUCKET`          |
| Plain vars             | `wrangler.toml` `[vars]`                | Per project | `CONTENT_MODE`, locales, URLs |
| Cloudflare secrets     | `wrangler secret put`                   | Per project | `BETTER_AUTH_SECRET`          |
| GitHub Actions secrets | GitHub repo/org → Settings → Secrets    | CI only     | `CLOUDFLARE_API_TOKEN`        |

Secrets are **never** committed to `wrangler.toml`. Plain vars can be, and are safe to read in both server and client code (treat them like public config).

### 1. GitHub Actions secrets (for CI deploy)

Configured at the GitHub **org or repo** level. At Codustry they're already set on the organization and inherited by every repo:

| Secret                  | Purpose                                                  |
| ----------------------- | -------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Lets the CI runner call the Cloudflare API (deploy, D1). |
| `CLOUDFLARE_ACCOUNT_ID` | Tells `wrangler` which account to deploy into.           |

Token permissions required: **Workers Scripts — Edit**, **Account D1 — Edit**, **Account Workers KV Storage — Edit**, **Workers R2 Storage — Edit**, **Zone DNS — Read** (for routes). Create at `dash.cloudflare.com/profile/api-tokens` → "Edit Cloudflare Workers" template, then narrow to your account.

### 2. Cloudflare secrets (Worker runtime, encrypted)

Set once per environment via `wrangler secret put <NAME>`:

| Secret               | Purpose                                                            | How to generate           |
| -------------------- | ------------------------------------------------------------------ | ------------------------- |
| `BETTER_AUTH_SECRET` | Signs/encrypts Better Auth session cookies. Must be long + random. | `openssl rand -base64 32` |

> **Never** put these in `[vars]` — they leak to the dashboard and CI logs.

### 3. Cloudflare bindings (wrangler.toml)

Provisioned once per project via `pnpm setup`, then referenced by ID:

```toml
[[d1_databases]]
binding = "DB"                 # exposed as platform.env.DB
database_name = "khaopad-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"  # from `wrangler d1 create`
migrations_dir = "drizzle"

[[r2_buckets]]
binding = "MEDIA_BUCKET"       # exposed as platform.env.MEDIA_BUCKET
bucket_name = "khaopad-media"

[[kv_namespaces]]
binding = "CONTENT_CACHE"      # exposed as platform.env.CONTENT_CACHE
id = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"               # from `wrangler kv namespace create`
```

### 4. Plain environment variables (wrangler.toml `[vars]`)

Non-secret config that ships with the Worker:

| Var                 | Required | Default               | Purpose                                                                         |
| ------------------- | :------: | --------------------- | ------------------------------------------------------------------------------- |
| `SUPPORTED_LOCALES` |   yes    | `en,th`               | Comma-separated. Must match `project.inlang/settings.json`.                     |
| `DEFAULT_LOCALE`    |   yes    | `en`                  | Fallback locale. Must be in `SUPPORTED_LOCALES`.                                |
| `PUBLIC_SITE_URL`   |   yes    | `https://example.com` | Canonical origin for both surfaces (one host).                                  |
| `CMS_SITE_URL`      |   yes    | = `PUBLIC_SITE_URL`   | Deprecated alias kept for media URL generation; same host as public since v1.1. |
| `BETTER_AUTH_URL`   |   yes    | = `PUBLIC_SITE_URL`   | Base URL Better Auth uses in callbacks/cookies.                                 |

### 5. Routes & DNS (production only)

Uncomment the `routes` block in `wrangler.toml` after your domain is on Cloudflare:

```toml
routes = [
  { pattern = "example.com/*", zone_name = "example.com" },
]
```

A single proxied (orange-cloud) DNS record pointing at the Worker is enough — Cloudflare terminates TLS and the `surfaceHook` in `hooks.server.ts` decides whether each request is the public site (`/`) or the admin CMS (`/cms/*`).

### 6. Local dev

- `pnpm wrangler:dev` (recommended) — Wrangler spins up local simulators for D1/R2/KV. Reads `wrangler.toml` `[vars]`; secrets come from `.dev.vars` (gitignored). The production `database_id`/KV `id` are ignored locally — a local SQLite file is used instead.
- `pnpm dev` — plain Vite, no Cloudflare runtime. Renders the 503 "Configuration required" screen so missing bindings are obvious.

Create `.dev.vars` (gitignored) for local-only secrets:

```
BETTER_AUTH_SECRET=dev-local-only-not-a-real-secret
```

### Deployment checklist

- [ ] `pnpm setup` ran and `wrangler.toml` has real `database_id` + KV `id`
- [ ] `BETTER_AUTH_SECRET` set in Cloudflare (`wrangler secret put BETTER_AUTH_SECRET`)
- [ ] `PUBLIC_SITE_URL`, `CMS_SITE_URL`, `BETTER_AUTH_URL` updated to real domain in `[vars]`
- [ ] `routes` block uncommented with real domain + zone
- [ ] DNS record points to the Worker in Cloudflare
- [ ] GitHub org/repo has `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
- [ ] `pnpm build` passes locally
- [ ] Migrations applied remote (`pnpm db:migrate:remote`) or CI will do it on first push

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

Khao Pad started as a CMS. Through v1.5 it became a complete content layer (write, schedule, search, version, audit). v1.6 onward turns it into the **driver of a non-ecommerce website** — meaning a site owner installs Khao Pad and gets the content layer **plus** the surrounding machinery a real website needs (SEO, analytics, IA, performance, engagement).

| Version  | Theme                       | Status       | Highlights                                                                                          |
| -------- | --------------------------- | ------------ | --------------------------------------------------------------------------------------------------- |
| **v1.0** | MVP                         | ✅ Shipped    | M1–M7: scaffold, D1 migrations, Better Auth, media library, taxonomy, deploy pipeline, MD editor    |
| **v1.1** | Path-prefix routing         | ✅ Shipped    | `/cms/*` instead of `cms.` subdomain, shadcn admin reskin, D1+Date binding fix, scope tightening    |
| **v1.2** | Users & settings UIs        | ✅ Shipped    | `/cms/users` (roles, last-super-admin guard), `/cms/settings`, `canManageUser` permission helper    |
| **v1.3** | Workflow trio               | ✅ Shipped    | Token invitations, audit-log viewer, scheduled publishing                                           |
| **v1.4** | Full-text search            | ✅ Shipped    | SQLite FTS5 over per-locale localizations, public `/blog?q=`, CMS list filter                       |
| **v1.5** | Content versioning          | ✅ Shipped    | Per-article revision history, line diff, one-click restore, attribution                             |
| **v1.6** | SEO foundations             | ✅ Shipped    | Per-page meta, sitemap, robots, JSON-LD, RSS/Atom, slug redirects, SEO scoring hint                 |
| **v1.7** | Pages, navigation, IA       | ✅ Shipped    | Media folders, reusable blocks, cookie consent, static pages, navigation manager, seed:legal |
| **v1.8** | Analytics & insight         | 🚧 Pending   | Privacy-friendly D1 page-views, top articles, search-term insights, per-article sparkline          |
| **v1.9** | Performance & trust         | 🚧 Pending   | Cloudflare Images responsive `srcset`, cache headers, custom 404/500, cookie consent, health check |
| **v2.0** | Engagement & growth         | 🚧 Pending   | Forms, newsletter, comments, webhooks, public read-only API                                         |

**Backlog** (not committed): OAuth providers, block-based editor, AI-assisted authoring, multi-site / workspaces, A/B testing, member-only / paid content.

See [docs/MILESTONES.md](docs/MILESTONES.md) for the detail block on every shipped and pending milestone, and [open issues](https://github.com/codustry/khaopad/issues) for the per-milestone tracking.

## License

MIT — Codustry

---

Built with 🍳 by [Codustry](https://codustry.com)

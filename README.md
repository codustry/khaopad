# Khao Pad (ข้าวผัด)

**The open-source website platform for Cloudflare — built to be forked.** A complete content + commerce engine on Workers + D1 + R2 + KV, with a versioned theme contract that lets every deployment own its look **and** keep taking engine upgrades, conflict-free.

> ข้าวผัด = Fried rice. Everyone wants something slightly different, but in the end it's the same core dish — just with different sauces and ingredients.

🌐 **Live demo**: [khaopad-example.codustry.workers.dev](https://khaopad-example.codustry.workers.dev) ([source](https://github.com/codustry/khaopad-example) — a real themed fork) · 🌍 **Marketing site**: [khaopad-website.codustry.workers.dev](https://khaopad-website.codustry.workers.dev)

### Try the CMS

The demo's admin panel is open with an editor account — sign in and click around:

|              |                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------ |
| **URL**      | [khaopad-example.codustry.workers.dev/admin](https://khaopad-example.codustry.workers.dev/admin) |
| **Email**    | `demo@khaopad.dev`                                                                               |
| **Password** | `KhaoPadDemo!2026`                                                                               |

Every plugin is enabled, so the sidebar shows the full surface: articles, pages, media, navigation, forms, newsletter, comments, webhooks, API keys — and the shop's products, collections, orders, and discounts. Try **⌘K** for the command palette and the header toggle for dark mode; the whole admin works in English and Thai.

The database resets nightly, so nothing you do there can break anything. Payments run against BeamCheckout's sandbox — no real charge is ever made.

## The two-layer model

Every Khao Pad install is two layers with a contract between them:

- **The engine** (this repo) — routes, loads, CMS, commerce, auth, SEO, i18n plumbing. You upgrade it by merging upstream, and fixes — a checkout race, a payment bug, an SEO improvement — reach your site automatically.
- **The theme** (your fork) — header, footer, homepage, checkout field additions, fonts, colors, head tags. It lives in code upstream never touches, registered through seams the engine promises to keep.

The promise is written down and machine-enforced: **[docs/THEME-CONTRACT.md](docs/THEME-CONTRACT.md)**, versioned as `THEME_CONTRACT_VERSION` (currently **1.0.0**), guarded by `pnpm run guard:contract` in CI. If an engine change would delete anything a theme can depend on — a chrome slot, a props field, a Paraglide message key, a building-block component — the build fails with the item named until the contract's MAJOR version is bumped explicitly. A breaking change can never ship as a quiet refactor.

### Theming in five minutes

Your visual identity goes in `src/lib/deployment/` (yours by contract) and registers itself:

```ts
// src/lib/deployment/chrome.ts
import { setChrome } from "$lib/components/www/chrome";
import MyHeader from "./MyHeader.svelte";
import MyHome from "./MyHome.svelte";

setChrome({ header: MyHeader, home: MyHome }); // partial is fine — keep the stock footer
```

```ts
// src/lib/plugins/registrations.ts  (loaded by server AND client — required)
import "$lib/deployment/chrome";
```

| What you customize                                 | How                                                                                         |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Header / footer / homepage body                    | `setChrome({ header, footer, home })`                                                       |
| Checkout additions (e.g. Thai tax invoice fields)  | `registerCheckoutSlots()` — contributions flow into the order's `billingAddress` end-to-end |
| Fonts, meta, verification tags                     | `src/app.head.html` — injected into `<head>` on every page                                  |
| Brand colors, radius, display font, logo           | `/admin/settings` theme tokens — operator config, zero code                                 |
| Building blocks (`ProductCard`, `HeaderSearch`, …) | import from `$lib/components/shop` / `$lib/components/www` — contract-stable                |

The engine keeps SEO tags, the cookie banner, and consent handling out of theme reach — a theme cannot accidentally break compliance. Commerce pages (cart, checkout, product) stay engine-owned so pricing and inventory fixes reach every deployment; [Shopify learned this one the expensive way](https://www.shopify.com/partners/blog/checkout-liquid-deprecation).

The reference fork migrated its custom homepage onto these seams in [one commit](https://github.com/codustry/khaopad-example/commit/cc1e16b) — and its next upstream sync was the first zero-conflict merge in the project's history.

## What ships (v4.3.0)

The short version — [docs/MILESTONES.md](docs/MILESTONES.md) has the complete history from v1.0.

**Content platform** — markdown-first articles + static pages, per-locale (EN + TH out of the box), shared English-ASCII slugs, R2 media library with folders and responsive `srcset`, scheduled publishing, FTS5 full-text search, revision history with diff + restore, audit log, token invitations, typed content collections with a `find()`/`populate` query layer.

**Growth machinery** — full SEO surface (meta, canonical, hreflang, JSON-LD, sitemaps, RSS, fail-closed robots.txt, slug 301s), privacy-friendly D1 analytics with search insights, forms, newsletter (single/double opt-in), moderated comments, HMAC-signed webhooks, public REST API with scoped keys.

**Shop plugin** — Thailand-first ecommerce on the plugin runtime: catalog with variants and collections, atomic inventory ledger, session carts, localized checkout, BeamCheckout payments (PromptPay QR, cards, LINE Pay, TrueMoney), discount codes, abandoned-cart recovery, article↔product federation, funnel analytics. Money is integer satang throughout — no floats in the price path.

**Admin experience** — shared design system across 40+ pages, dark mode, ⌘K command palette, sticky save bar with unsaved-changes guard, in-admin secrets portal (AES-GCM envelope encryption), self-service profile + password change, full EN/TH admin i18n.

**Theme/engine split (v4.2–v4.3)** — everything in [The two-layer model](#the-two-layer-model): chrome registry, checkout slots, deployment head fragment, theme tokens, and the versioned, CI-guarded contract. Plus render-regression guards (`guard:css`, `guard:head`) that catch the class of bug where every check stays green while the page renders wrong.

**Platform fundamentals** — one Worker, two surfaces (`/` public, `/admin`); Better Auth with four roles (super_admin > admin > editor > author); rate-limited credential endpoints; real staging + production pipeline; sub-10ms D1 reads worldwide.

## Architecture

```
┌──────────────────────────────────────────────┐
│              Single SvelteKit App             │
│                                               │
│  hooks.server.ts (path-based surface)         │
│    /*        → (www)/   public site           │
│    /admin/*  → (admin)/ admin panel           │
│    /api/*    → auth, shop, public REST        │
│                                               │
│  Engine routes ──resolve──▶ theme registry    │
│    (chrome.home ?? DefaultHome, …)            │
│                                               │
│  ContentProvider → D1ContentProvider          │
│  Cloudflare: Workers · D1 · R2 · KV           │
└──────────────────────────────────────────────┘
```

**Stack**: [SvelteKit](https://svelte.dev) · [Tailwind CSS](https://tailwindcss.com) · [shadcn/ui (svelte)](https://shadcn-svelte.com) · [Drizzle ORM](https://orm.drizzle.team) · [Better Auth](https://better-auth.com) · [Paraglide JS](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) · [Cloudflare Workers](https://workers.cloudflare.com) / [D1](https://developers.cloudflare.com/d1/) / [R2](https://developers.cloudflare.com/r2/) / [KV](https://developers.cloudflare.com/kv/)

## Using Khao Pad in your project

Khao Pad is a **template you fork**, not a hosted service. Every project provisions its own isolated D1 database, R2 bucket, and KV namespace in its own Cloudflare account — nothing is shared between installations.

### One-time merge setup for forks

Run this once in your fork:

```bash
git config merge.ours.driver true
```

`.gitattributes` auto-resolves the conflicts that carry no decision (chiefly `README.md` — your fork's README documents _your_ site and should never adopt upstream's prose). Git ships the name `ours` but **not** the driver, so without that command the rules are silently ignored.

Deliberately still conflicting, because each needs a human:

| File             | Why                                                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wrangler.toml`  | Holds your bindings _and_ receives upstream additions. Auto-keeping your copy would silently drop new config and a feature would look broken for no reason. |
| `pnpm-lock.yaml` | Marked `binary`, so git won't produce a lockfile neither side tested. Resolve with `git checkout --theirs pnpm-lock.yaml && pnpm install`.                  |

Everything visual belongs in `src/lib/deployment/` and the seams above — an upgraded fork should see **no** conflicts in engine files. If you still carry forked engine files for looks, the [v4.3.0 release notes](https://github.com/codustry/khaopad/releases/tag/v4.3.0) walk through migrating them onto the contract.

### Setup

Prerequisites: [Node.js](https://nodejs.org/) 22+, [pnpm](https://pnpm.io/) 9+, a Cloudflare account, `wrangler` CLI (`pnpm add -g wrangler` + `wrangler login`).

```bash
# 1. Fork on GitHub (or clone directly)
git clone https://github.com/your-org/your-project.git
cd your-project

# 2. Install dependencies
pnpm install

# 3. Provision Cloudflare resources (D1 + R2 + KV) in one command
pnpm setup
# Prints the database_id and KV id — paste them into wrangler.toml.

# 4. Set your Better Auth secret (any long random string)
wrangler secret put BETTER_AUTH_SECRET

# 5. Apply migrations and seed sample data into local D1
pnpm db:migrate
pnpm db:seed

# 6. Start the dev server (Wrangler, uses local D1/R2/KV simulators)
pnpm wrangler:dev
```

- Public site: `http://localhost:5173` · Admin: `http://localhost:5173/admin`
- First admin signup (one-shot, before any user exists): `/admin/signup`
- For plain Vite without bindings, `pnpm dev` renders a friendly 503 "Configuration required" screen, and local-only secrets go in `.dev.vars` (gitignored): `BETTER_AUTH_SECRET=dev-local-only-not-a-real-secret`

### Bindings

Cloudflare bindings are provisioned once (`pnpm setup` runs all three), then referenced by ID in `wrangler.toml`. Code never hardcodes account IDs — Cloudflare injects bindings into `platform.env` at runtime.

| Binding         | Resource     | Created by                         | Referenced as |
| --------------- | ------------ | ---------------------------------- | ------------- |
| `DB`            | D1 database  | `wrangler d1 create <name>`        | `database_id` |
| `MEDIA_BUCKET`  | R2 bucket    | `wrangler r2 bucket create <name>` | `bucket_name` |
| `CONTENT_CACHE` | KV namespace | `wrangler kv namespace create`     | `id`          |

### Config layers

| Layer                  | Where it lives                          | Example                                                                     |
| ---------------------- | --------------------------------------- | --------------------------------------------------------------------------- |
| Bindings               | `wrangler.toml` `[[d1_databases]]` etc. | `DB`, `MEDIA_BUCKET`                                                        |
| Plain vars             | `wrangler.toml` `[vars]`                | `SUPPORTED_LOCALES`, `DEFAULT_LOCALE`, `PUBLIC_SITE_URL`, `BETTER_AUTH_URL` |
| Cloudflare secrets     | `wrangler secret put`                   | `BETTER_AUTH_SECRET` (`openssl rand -base64 32`)                            |
| GitHub Actions secrets | repo/org → Settings → Secrets           | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`                             |

Secrets are **never** committed to `wrangler.toml` — they leak to the dashboard and CI logs. Integration credentials (payments, email) can instead be managed at `/admin/settings/secrets` (AES-GCM encrypted at rest; env always wins). `BETTER_AUTH_SECRET` itself stays a Cloudflare secret — it is the root of trust.

### Deployment

Push to `main` → GitHub Actions builds, applies pending D1 migrations, and deploys the Worker (`.github/workflows/deploy.yml`). For a custom domain, uncomment the `routes` block in `wrangler.toml` and point one proxied DNS record at the Worker — `hooks.server.ts` splits public and admin surfaces by path.

Checklist: real `database_id` + KV `id` in `wrangler.toml` · `BETTER_AUTH_SECRET` set · `PUBLIC_SITE_URL` / `BETTER_AUTH_URL` on the real domain · routes + DNS · `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` in GitHub · `pnpm build` green.

## Content model

```
Article (shared)
├── id, slug (English ASCII), status, coverMedia, category, tags, author
├── Localization (EN) ← required, slug is derived from this title
│   └── title, excerpt, body (markdown), SEO fields
└── Localization (TH)
    └── title, excerpt, body (markdown), SEO fields
```

Articles share slug and media across languages; only text differs per locale. **Slugs are always English ASCII** (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), auto-generated from the English title — there is no per-language slug.

There are two i18n layers, kept deliberately separate: **Paraglide** message keys for the app shell (compile-time, type-safe, contract-stable for themes) and **content localizations** in D1 for user-generated text.

## User roles

| Role        | Create | Edit Own | Edit Any | Publish | Delete Any | Manage Users/Settings |
| ----------- | :----: | :------: | :------: | :-----: | :--------: | :-------------------: |
| Author      |  yes   |   yes    |    -     |    -    |     -      |           -           |
| Editor      |  yes   |   yes    |   yes    |   yes   |     -      |           -           |
| Admin       |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |
| Super Admin |  yes   |   yes    |   yes    |   yes   |    yes     |          yes          |

## Scripts

| Command                   | Description                                           |
| ------------------------- | ----------------------------------------------------- |
| `pnpm dev`                | Local dev server (plain Vite)                         |
| `pnpm wrangler:dev`       | Local dev with D1/R2/KV simulators                    |
| `pnpm build`              | Production build                                      |
| `pnpm test`               | Full test suite                                       |
| `pnpm run guard:css`      | CSS-inventory render-regression guard                 |
| `pnpm run guard:contract` | Theme-contract guard ([docs](docs/THEME-CONTRACT.md)) |
| `pnpm db:generate`        | Generate migration from schema changes                |
| `pnpm db:migrate`         | Apply migrations locally                              |
| `pnpm db:migrate:remote`  | Apply migrations to production D1                     |
| `pnpm deploy`             | Build + deploy to Cloudflare Workers                  |

## Version history

| Era           | Theme                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| v1.0–v1.5     | The CMS core: auth, media, taxonomy, search, revisions, scheduling, audit                            |
| v1.6–v2.0     | The website machinery: SEO, IA, analytics, performance, forms/newsletter/comments/webhooks/API       |
| v3.0–v3.5     | Plugin runtime + the shop plugin (catalog → payments → discounts → recovery)                         |
| v3.6–v3.10    | Typed collections, secrets portal, admin design system, funnel localization                          |
| v4.0–v4.1     | Admin UX phase 2, product bundles, careers page                                                      |
| **v4.2–v4.3** | **The theme/engine split (#174): chrome + checkout seams, theme tokens, and the versioned contract** |

Full detail: [docs/MILESTONES.md](docs/MILESTONES.md) · [releases](https://github.com/codustry/khaopad/releases) · [open issues](https://github.com/codustry/khaopad/issues).

**Backlog** (not committed): OAuth providers, block-based editor, AI-assisted authoring, multi-site / workspaces, A/B testing, member-only / paid content.

## License

MIT — Codustry

---

Built with 🍳 by [Codustry](https://codustry.com)

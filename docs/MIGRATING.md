# Migrating an existing SvelteKit app into Khao Pad

> **Status: draft** — for teams that already have a SvelteKit site and want to adopt Khao Pad as the CMS layer without throwing their app away.

## When this guide applies

You have a working SvelteKit app. It might already be on Cloudflare, Vercel, or Node. You want to:

- Add a CMS-backed blog / articles section.
- Keep your existing marketing pages, product UI, components, etc.
- Gain the `www` / `cms` split with one deploy.

This guide is **not** for: starting a new project (just fork Khao Pad directly), or keeping your existing routes unchanged while bolting Khao Pad on as a separate service (that's a separate "headless" integration — future note).

## The shape of the end state

Khao Pad **is** a SvelteKit app. There's no "Khao Pad runtime" you import. Migrating means your code lives _inside_ the Khao Pad repo layout, not beside it:

```
your-app/                         ← repo root, after migration
├── src/routes/
│   ├── (www)/                    ← YOUR existing public pages move here
│   │   ├── +layout.svelte
│   │   ├── +page.svelte          ← your landing page
│   │   ├── about/
│   │   ├── pricing/
│   │   ├── contact/
│   │   └── [locale]/blog/…       ← Khao Pad's blog routes stay (or replace yours)
│   ├── (cms)/                    ← Khao Pad's admin — leave alone unless customising
│   │   ├── dashboard/
│   │   ├── articles/
│   │   └── media/
│   └── api/
│       ├── auth/[...all]/        ← Better Auth catchall
│       ├── media/                ← R2 media endpoints
│       └── your-existing-api/    ← YOUR existing API routes move here
├── src/lib/
│   ├── components/               ← YOUR components (merge with Khao Pad's shadcn setup)
│   ├── server/
│   │   ├── auth/                 ← Khao Pad — leave alone
│   │   ├── content/              ← Khao Pad — leave alone
│   │   ├── media/                ← Khao Pad — leave alone
│   │   └── your-services/        ← YOUR server-only code lives here
│   └── paraglide/                ← Khao Pad — generated, gitignored
├── messages/                     ← UI translations (merge yours in)
├── drizzle/                      ← D1 migrations — add yours after 0000
└── wrangler.toml                 ← Cloudflare bindings
```

The mental model: **Khao Pad is a template that already has `(www)` and `(cms)` route groups wired up.** Your job is to move your routes into `(www)`, keep the `(cms)` group untouched, and reconcile shared things (Tailwind config, components, i18n) in `src/lib`.

## Migration steps

### 1. Fork or clone Khao Pad into a new branch of your repo

Don't do this in your main branch yet. Create `feat/khaopad-integration` and work there.

```bash
# In your existing repo:
git checkout -b feat/khaopad-integration

# Pull Khao Pad's files in as a starting point (adjust to taste):
git remote add khaopad https://github.com/YOUR-ORG/khaopad.git
git fetch khaopad main
# Merge or cherry-pick. If your repo is small, a full merge is cleanest:
git merge khaopad/main --allow-unrelated-histories
```

You'll hit merge conflicts on `package.json`, `svelte.config.js`, `vite.config.ts`, and `tsconfig.json`. Resolve by **taking Khao Pad's versions as the base** and re-adding your dependencies on top — Khao Pad pins Vite 5.4.x, Svelte 5, SvelteKit 2, adapter-cloudflare, Tailwind 4, and Better Auth 1.5+, and the versions matter.

### 2. Move your public routes into `(www)`

SvelteKit route groups in parentheses don't change URLs. Moving `src/routes/about/+page.svelte` → `src/routes/(www)/about/+page.svelte` keeps the URL `/about` but attaches the public-site layout + subdomain restriction.

```bash
# Assuming your existing routes are flat under src/routes/
mkdir -p src/routes/\(www\)/
# Move each non-CMS, non-api folder into (www). Keep /api at the top level.
git mv src/routes/about src/routes/\(www\)/about
git mv src/routes/pricing src/routes/\(www\)/pricing
# …etc
```

**What to leave at the top level:**

- `src/routes/api/` — API endpoints. They're accessible on both subdomains.
- `src/routes/+error.svelte` — global error page (if you have one).

**What NOT to move into `(cms)`:** your own admin panels, if any. The `(cms)` group has auth guards and subdomain enforcement specific to Khao Pad. If you have your own admin UI, either:

- Fold it into Khao Pad's CMS (add a route under `(cms)/your-feature/`), or
- Put it under `(www)/admin/` with your own auth, but it'll be visible on the public subdomain — usually not what you want.

### 3. Reconcile `+layout.svelte`

Your existing root `+layout.svelte` probably imports your global CSS, nav bar, footer, theme provider. Khao Pad has a minimal root layout (`src/routes/+layout.svelte`) and a public-site-specific layout (`src/routes/(www)/+layout.svelte`).

**Rule of thumb:**

- Things that should appear on **both** `www` and `cms` (e.g. `<ThemeProvider>`, global `app.css`) go in `src/routes/+layout.svelte`.
- Things that are **public-site-only** (nav, footer, marketing analytics) go in `src/routes/(www)/+layout.svelte`.
- Leave `src/routes/(cms)/+layout.svelte` alone unless you have a reason.

### 4. Merge `src/lib/components`

Khao Pad uses **shadcn/ui via bits-ui** + Tailwind 4. If your components already use shadcn-svelte, the merge is mechanical. If you have your own component library (e.g. custom Button), two options:

- **Rename to avoid collision.** Keep both — your `MyButton.svelte` next to shadcn's `Button.svelte`.
- **Migrate to shadcn incrementally.** Use shadcn for new CMS-adjacent pages, leave your existing pages on your own components.

Don't try to replace everything in one PR.

### 5. Reconcile i18n

Khao Pad uses **Paraglide JS 2.0** for UI strings. If you're not doing i18n today, nothing changes — `messages/en.json` is the only file that matters and Paraglide compiles it into `$lib/paraglide/messages`.

If you already use another i18n library (`svelte-i18n`, `typesafe-i18n`, `inlang/paraglide-js v1`), you have three options:

1. **Keep both.** Paraglide powers the CMS admin; your existing setup powers your existing pages. They don't know about each other.
2. **Migrate to Paraglide.** Import your existing strings as JSON into `messages/*.json`, replace calls. This is the long-term tidy option.
3. **Disable Paraglide in the CMS.** Strip `m.*` calls from Khao Pad's admin pages and hard-code English. Supported but you lose Thai support in CMS — only do this if you don't need it.

See [I18N.md](./I18N.md) for why Khao Pad has two layers (UI vs content) and why the content layer isn't your concern here.

### 6. Reconcile styling

Khao Pad uses **Tailwind CSS 4** with CSS variables for theming (`src/app.css`). If you're on Tailwind 3, plan an upgrade path — Tailwind 4 has config-in-CSS, not `tailwind.config.js`. The `@tailwindcss/vite` plugin is in `vite.config.ts`.

If your existing styles are plain CSS / SCSS / vanilla-extract: they keep working. Tailwind doesn't care. Your component styles stay scoped.

### 7. Reconcile your existing database

This is the big one. Khao Pad ships with **D1** + **Drizzle**. Your existing app might use Postgres, SQLite, Prisma, something else.

**If you're already on D1:** great. Merge your Drizzle schema into `src/lib/server/content/schema.ts` (or adjacent), re-run `pnpm db:generate`, ship.

**If you're on a different database:** you have two choices, in order of effort:

1. **Dual-database.** Khao Pad keeps D1 for CMS content; your existing code keeps its DB for your business data. Two connection strings, two ORMs, two migration pipelines. Simplest integration, acceptable long-term for small teams.
2. **Move your data to D1.** Rewrite your queries to Drizzle-on-D1. Works if your data is relational, < ~10GB, and doesn't need heavy analytics. D1 is SQLite — read [PLATFORM-NOTES.md §1](./PLATFORM-NOTES.md) for what you give up (no interactive transactions).

For most teams the answer is **#1 (dual-database) during migration, then evaluate**.

### 8. Reconcile auth

Khao Pad uses **Better Auth** with D1-backed sessions. Cookies are scoped to the root domain so they cross `www` and `cms`.

**If you have no auth today:** Khao Pad's auth is a free win. Use it for your app too via the same session hook.

**If you have existing auth** (Clerk, Auth.js, Lucia, custom):

- The pragmatic path is to keep both. Khao Pad uses Better Auth for CMS access only; your app uses your auth for users.
- Don't try to unify in the migration PR. That's a separate, scarier change.

If you want to replace your auth with Better Auth, see [BETTERAUTH.md](./BETTERAUTH.md) for the integration surface.

### 9. Update `wrangler.toml`

Merge your bindings into Khao Pad's `wrangler.toml`. Keep Khao Pad's:

- `[[d1_databases]] binding = "DB"` (CMS data)
- `[[r2_buckets]] binding = "MEDIA_BUCKET"`
- `[[kv_namespaces]] binding = "CONTENT_CACHE"`
- `compatibility_flags = ["nodejs_compat"]`
- `assets = { directory = ..., binding = "ASSETS" }`

Add yours as additional bindings with different binding names (e.g. `binding = "USER_DB"` for your business DB).

### 10. Run the first-deploy checklist

See [DEPLOYMENT.md](./DEPLOYMENT.md). At minimum:

- [ ] `pnpm setup` to provision D1/R2/KV for Khao Pad
- [ ] `wrangler secret put BETTER_AUTH_SECRET`
- [ ] Both `www.*` and `cms.*` DNS records point to the Worker
- [ ] `pnpm build` passes locally
- [ ] Migrations applied: `pnpm db:migrate:remote`
- [ ] Bootstrap first super_admin: visit `cms.*/signup`

## Where does YOUR code actually go?

Quick decision tree:

| Your code is…                                    | Put it in…                                                                    |
| ------------------------------------------------ | ----------------------------------------------------------------------------- |
| A public page (`/about`, `/pricing`, landing)    | `src/routes/(www)/…`                                                          |
| A reusable Svelte component                      | `src/lib/components/…`                                                        |
| A server-only utility (sends emails, calls APIs) | `src/lib/server/…`                                                            |
| A shared client-side helper                      | `src/lib/…`                                                                   |
| An API endpoint (`/api/foo`)                     | `src/routes/api/foo/+server.ts`                                               |
| A background job / cron                          | Cloudflare Workers cron triggers in `wrangler.toml` + a `scheduled()` handler |
| Static assets (images, fonts)                    | `static/`                                                                     |
| Database migrations for YOUR tables              | `drizzle/` (number after Khao Pad's existing migrations)                      |
| Tests                                            | Next to the code (`*.test.ts`) or `tests/`                                    |

## Things that will bite you

Read [PLATFORM-NOTES.md](./PLATFORM-NOTES.md) cover to cover before deploying. The short list:

- **No Node `fs` at runtime** — if your existing code reads template files, inline them at build time.
- **Request-scoped `platform.env`** — no module-level `import { db }`. Construct per request.
- **D1 has no interactive transactions** — wrap multi-statement work in `d1.batch()`.
- **Cookies are domain-scoped** — make sure your cookies work across `www.*` and `cms.*` if users need to cross.
- **Vite 5 pinned** — don't bump to 6 until the SvelteKit guard issue clears.

## What's explicitly out of scope for this guide

- **Edge Functions → Workers migration.** If you're on Vercel Edge Functions, there's a separate porting effort for `next/request` idioms, and we haven't written it up yet.
- **SSR → client-rendered conversion.** If parts of your app are `export const ssr = false`, they keep working on Workers, but performance characteristics differ. Benchmark before you cut over.
- **Multi-tenant / white-label.** Khao Pad assumes one site per deploy. See [ARCHITECTURE.md §non-goals](./ARCHITECTURE.md) — multi-tenant is a v3 question.

---

_Last touched: 2026-04-18._

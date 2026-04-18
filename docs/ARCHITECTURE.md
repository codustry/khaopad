# Architecture

> **Status: draft** — the high-level tour of how requests move through Khao Pad.

## The one-line summary

One SvelteKit app, one Cloudflare Worker, two public subdomains: `www.*` for the public site, `cms.*` for the admin panel. A hook looks at the `Host` header and dispatches to one of two route groups.

## Why one app instead of two

We evaluated splitting into `khaopad-www` and `khaopad-cms` Workers. Rejected because:

- **Two builds, two deploys, two Wrangler configs** — operationally heavier for no user-facing gain.
- **Shared types get worse** — the `ContentProvider` interface, auth types, permission helpers are used by both sides. A monorepo-with-shared-package split solves this but adds build plumbing we don't need yet.
- **Cold start doubles** — Workers isolate per-deploy. Two Workers = two cold starts for a user who logs in on `cms.*` after reading `www.*`.
- **Session cookies are scoped per-domain** — we *want* them to cross `www` and `cms` on the same root domain for things like "edit this page" deep-links, which is easier with one Worker.

The one cost: the Worker bundle carries both public-site and admin-panel code. Tree-shaking and route-level code splitting keep that manageable.

## Why Cloudflare Workers, not Pages

Pages was SvelteKit's canonical Cloudflare target for years. We use Workers because:

- **Multi-subdomain routing** — Pages routes by path, Workers routes by hostname pattern in `wrangler.toml`. The `www` vs `cms` split is a Workers primitive, not a Pages one.
- **Wrangler dev parity** — `pnpm wrangler:dev` locally gives us the same runtime (D1/R2/KV simulators) as production. Pages dev has caught up but historically lagged.
- **Cloudflare is consolidating** — Pages + Workers is becoming "Workers with static assets" (see `assets = { directory = ..., binding = "ASSETS" }` in our `wrangler.toml`). Starting on Workers means no migration later.

## Request lifecycle

Every request runs through five hooks in `src/hooks.server.ts`, in order:

```
Request
  │
  ▼
subdomainHook             — reads Host header, sets locals.subdomain = "www" | "cms"
  │                         blocks CMS routes from www and vice versa (404)
  ▼
bindingsHook              — validates platform.env (returns 503 config page if missing)
  │                         constructs D1ContentProvider + R2MediaService
  │                         sets locals.locale from URL (/en/*, /th/*)
  ▼
configurationGuardHook    — renders the 503 "Configuration required" screen when
  │                         bindings missing; exempts /@, /_app, /node_modules, etc.
  ▼
paraglideLocaleHook       — installs AsyncLocalStorage so m.foo() reads the request's
  │                         locale (not a stale cookie). See I18N.md for the bug this fixes.
  ▼
authHook                  — getSession() → locals.user, locals.session (null when absent)
  │
  ▼
(route load + action)
```

After the hook chain, SvelteKit runs:

1. The matched **layout** `+layout.server.ts` (e.g. `(cms)/+layout.server.ts` enforces auth).
2. The matched **page** `+page.server.ts` (runs DB queries via `locals.content`).
3. The Svelte component server-renders.
4. Cloudflare streams the response.

## Route groups

SvelteKit's parenthesized folder names don't affect URLs — they just share a layout. We use them to split public and admin:

```
src/routes/
├── (www)/                 # Public site. No auth required.
│   ├── +layout.svelte
│   ├── +page.svelte       # Root (serves default locale landing)
│   └── [locale]/
│       ├── +page.svelte
│       └── blog/
│           ├── +page.server.ts
│           ├── +page.svelte
│           └── [slug]/
│               ├── +page.server.ts
│               └── +page.svelte
├── (cms)/                 # Admin. Auth required except /login and /signup.
│   ├── +layout.server.ts  # Auth guard
│   ├── +layout.svelte     # Sidebar nav
│   ├── login/
│   ├── signup/
│   ├── dashboard/
│   └── articles/
│       ├── +page.server.ts     # list + delete action
│       ├── +page.svelte
│       ├── ArticleForm.svelte  # shared editor component
│       ├── new/
│       └── [id]/               # edit + publish/unpublish/delete
└── api/
    ├── auth/[...all]/+server.ts  # Better Auth catchall
    └── media/[id]/+server.ts     # R2 media serve (planned for M4)
```

The subdomain hook enforces that `/dashboard`, `/articles`, etc. are only reachable on `cms.*`, and `/[locale]/blog` only on `www.*`.

## Content storage abstraction

Routes never touch D1 or R2 directly. They go through `locals.content` (a `ContentProvider`) and `locals.media` (a `MediaService`), constructed per-request in `bindingsHook`. The interface lives in `src/lib/server/content/types.ts`; implementations in `src/lib/server/content/providers/`.

Today there's one active provider (`D1ContentProvider`). A `GitHubContentProvider` shell exists for Mode B (planned v1.1) — same interface, markdown files in a repo instead of D1 rows. Switching modes is a single env var (`CONTENT_MODE=d1|github`), no route code changes.

See [CONTENT-MODEL.md](./CONTENT-MODEL.md) for schema details.

## Where each concern lives

| Concern                         | File(s)                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| Subdomain dispatch              | `src/hooks.server.ts` (`subdomainHook`, `isCmsRoute`)       |
| Platform binding validation     | `src/lib/server/config/platform-status.ts`                  |
| Content provider interface      | `src/lib/server/content/types.ts`                           |
| D1 provider (active)            | `src/lib/server/content/providers/d1.ts`                    |
| GitHub provider (stub)          | `src/lib/server/content/providers/github.ts`                |
| Drizzle schema                  | `src/lib/server/content/schema.ts`                          |
| R2 media service                | `src/lib/server/media/`                                     |
| Auth construction               | `src/lib/server/auth/index.ts`                              |
| Bootstrap helpers               | `src/lib/server/auth/bootstrap.ts`                          |
| Role permissions                | `src/lib/server/auth/permissions.ts`                        |
| i18n helpers                    | `src/lib/i18n/index.ts` (content), `src/lib/paraglide/` (UI, generated) |
| Slug normalization              | `src/lib/utils.ts` (`slugify`, `generateSlugFromTitle`)     |

## Deliberate non-goals for v1

- **No ISR/incremental caching.** SvelteKit + Workers already edge-cache static assets and HTML where sensible. KV-backed content caching is on the v2 roadmap, not now.
- **No multi-tenant.** One fork = one site. Multi-site support is v3.
- **No realtime.** Article drafts don't sync between tabs. Add when someone actually asks.
- **No plugin system.** Every extension point today is a TypeScript module. Runtime plugins are v3 if ever.

---

_Last touched: 2026-04-18._

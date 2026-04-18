# Platform Notes — Cloudflare Gotchas

> **Status: draft** — things about Cloudflare Workers + D1 that bit us, and how we work around them. Kept here so the next engineer doesn't rediscover them.

## 1. D1 has no interactive transactions

D1 is SQLite under the hood, but exposed over HTTP. There's no `BEGIN TRANSACTION` / `COMMIT` semantic across round-trips. What you get is `d1.batch([statement1, statement2, ...])` — atomic, but you have to know all your statements upfront.

**Consequence:** "Insert user, insert credential row, insert session, return session token" — a sequence that's natural with `pg` transactions — has to be composed into a batch. Better Auth 1.5+ does this; earlier versions didn't and broke.

**If you're writing new code that needs multi-statement atomicity:** build the list of SQL statements, call `d1.batch()`, don't try to mimic transactions with `BEGIN` (it'll silently do the wrong thing).

## 2. `platform.env` is request-scoped

In a Worker, bindings live on the request context, not a module-level import. This is unlike Node where you'd `import { db } from './db'` once at boot.

**Consequence:** anything that needs the DB must receive it as a parameter. We have factory functions (`createAuth(env.DB, ...)`, `new D1ContentProvider(env.DB)`) rebuilt per request in `bindingsHook`. The cost is negligible (no DB connection, just wiring objects) — the win is that cross-request leakage is impossible by construction.

**If you're tempted to cache something at module scope:** don't, unless it's stateless (pure helpers, constants). Caches belong in KV or Durable Objects.

## 3. No filesystem at runtime

Workers don't have `fs`. You can't `readFile('templates/email.html')` at request time.

**Consequence:** templates, schemas, fixtures all get baked into the bundle at build time. Vite handles this for anything `import`ed. If you need runtime text, put it in a `[vars]` entry, a KV value, or a JS module string constant.

Our `drizzle/0000_nice_thor.sql` is never loaded at runtime — it's applied via `wrangler d1 migrations apply`, which runs on the Cloudflare control plane, not inside the Worker.

## 4. Vite 5 pin

`package.json` pins `vite` to `~5.4.21`. **Don't bump it to 6 yet.**

Reason: Vite 6 + SvelteKit + the Cloudflare adapter currently trips `vite-plugin-sveltekit-guard` during production builds (client bundle / `hooks.server.ts` boundary). The symptom is a build error complaining about server imports in client code that's wrong — the client code is correct, the guard is over-eager under Vite 6.

**When to revisit:** next major SvelteKit release, check the release notes for Vite 6 compatibility. Unpin, run `pnpm build`, deploy to staging, verify.

## 5. `nodejs_compat` flag

`wrangler.toml`: `compatibility_flags = ["nodejs_compat"]`. This lets Workers polyfill a subset of Node built-ins (`crypto`, `buffer`, `stream`). Better Auth needs `crypto` for password hashing; a few dependencies deep in the tree want `buffer`.

**Consequence:** our bundle is a bit larger than it would be on pure Web APIs. Acceptable — the alternative is patching upstream deps.

**Don't remove this flag** without re-testing auth end-to-end.

## 6. `@opentelemetry/api` as an optional dep

`better-auth`'s core ships a tracer module (`@better-auth/core/dist/instrumentation/tracer.mjs`) that imports `@opentelemetry/api`. We never use tracing, but the import is static, so Vite's tree-shaker can't skip it and the build fails with `ERR_MODULE_NOT_FOUND` if the package isn't installed.

Fix: `@opentelemetry/api` is in `optionalDependencies`. Installed on every `pnpm install`, included in the bundle but never executed at runtime.

**When Better Auth drops this dep:** remove it. Until then, don't be surprised to see it in the lockfile.

## 7. Subdomain routing runs on `Host`, not DNS

`subdomainHook` in `src/hooks.server.ts` looks at the `Host` header to decide `www` vs `cms`. In prod this just works — Cloudflare preserves the Host header when proxying.

**In local dev** you need `/etc/hosts` entries:

```
127.0.0.1  www.khaopad.local  cms.khaopad.local
```

And access the site via `http://www.khaopad.local:8787` / `http://cms.khaopad.local:8787`, not `localhost`. Without this, every request looks like `www` (the default fallback) and you can't reach the CMS locally.

## 8. SvelteKit route groups don't affect URLs

`src/routes/(www)/` and `src/routes/(cms)/` both serve paths starting at `/`. The parentheses are a SvelteKit convention for "share this layout without adding a URL segment."

**Consequence:** `/articles` could theoretically be served by either group. We resolve this with the subdomain hook: CMS routes are blocked on `www`, www-only routes are blocked on `cms`. The hook classification lists (`isCmsRoute`, `isWwwOnlyRoute`) must stay in sync with the folder contents.

**When you add a new CMS route folder:** remember to add the path prefix to `isCmsRoute`. There's no automatic detection.

## 9. D1 integer 0/1 vs boolean

SQLite (and therefore D1) has no native boolean. Drizzle maps `integer({ mode: 'boolean' })` to `1` / `0` on the wire. Our `users.email_verified` is typed `boolean` in TypeScript but stored `integer`.

**Consequence:** raw SQL (our `scripts/seed.ts`) must insert `1` or `0`, not `true` / `false`. Drizzle hides this in regular queries.

## 10. Timestamps are strings

All `created_at` / `updated_at` columns are `text` storing ISO-8601 strings. We picked strings over SQLite's `datetime()` because:

- String comparisons sort correctly (ISO-8601 is lexicographic-safe).
- Drizzle, JSON responses, and seed SQL all agree on the format without conversion layers.
- It's explicit — the column is obviously a timestamp, not a Unix integer or a SQLite-special type.

**When you need the value:** `new Date(row.createdAt)` in JS. When you want to insert: `new Date().toISOString()`.

## 11. Paraglide output is gitignored

`src/lib/paraglide/` is regenerated by the Vite plugin. Never edit files there by hand, and never commit them. If you see them in `git status`, your `.gitignore` is wrong.

**Consequence:** fresh clones need a `pnpm dev` / `pnpm build` / `npx paraglide-js compile` before `svelte-check` stops complaining about missing `$lib/paraglide/messages`. We should consider adding a `postinstall` script if this keeps tripping people up.

## 12. Why not Durable Objects (yet)

DOs would be useful for: per-article collaborative editing, content versioning with write-ahead locks, rate-limiting. None of those is v1 scope. When we do add them, they fit the same binding model — declare in `wrangler.toml`, receive on `platform.env.<BINDING>`.

---

_Last touched: 2026-04-18._

# Better Auth in Khao Pad

> **Status: draft** — destined for `docs.khaopad.com/auth`.

## What Better Auth is

Better Auth is a framework-agnostic TypeScript auth library. Unlike Auth.js/NextAuth, it's not route-handler-first — it's an **API object** you construct once and call from anywhere (SvelteKit server, route handlers, hooks, tests). It ships its own schema and session logic; the database is pluggable via adapters.

Three things it gives you:

1. **An HTTP handler** (`auth.handler(request)`) that serves `/api/auth/*` — sign-in, sign-up, session, OAuth callback, password reset, etc. You mount it once.
2. **A server API** (`auth.api.*`) for programmatic calls — `signUpEmail()`, `getSession()`, `signInEmail()`. No HTTP round-trip; it talks straight to the adapter.
3. **A schema** — `users`, `sessions`, `accounts`, `verifications` tables, managed by the adapter.

## The D1 problem it solves

Cloudflare D1 has no interactive transactions (no `BEGIN`/`COMMIT` across multiple statements). Most auth libraries assume Postgres-style transactions for "create user + create credential + create session" — they break on D1. Better Auth 1.5+ uses D1's `batch()` API (atomic multi-statement) under the Drizzle adapter, which is why we pinned `^1.5.0` in `package.json`.

## How it's wired in Khao Pad

### 1. Construction — `src/lib/server/auth/index.ts`

```ts
export function createAuth(d1: D1Database, env: { BETTER_AUTH_SECRET, BETTER_AUTH_URL }) {
  const db = drizzle(d1, { schema });
  return betterAuth({
    database: drizzleAdapter(db, { provider: "sqlite" }),
    secret: env.BETTER_AUTH_SECRET,           // signs session cookies
    baseURL: env.BETTER_AUTH_URL,             // for redirect/callback URLs
    basePath: "/api/auth",                    // where the handler is mounted
    emailAndPassword: { enabled: true },
    session: { expiresIn: 7d, updateAge: 1d },
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "author", input: false },
      },
    },
  });
}
```

Key choices:

- **Drizzle adapter over the Drizzle D1 instance** — Better Auth reads/writes through the same schema our content provider uses, so there's one source of truth in `src/lib/server/content/schema.ts`.
- **`input: false` on `role`** — the field exists on the user row but can't be set via the public sign-up API. Role changes only happen server-side (our `promoteToSuperAdmin` helper).
- **`createAuth` is a factory, not a singleton** — because `env.DB` only exists at request time in Workers. We rebuild it per request. It's cheap (no DB connection, just wiring).

### 2. HTTP handler — `src/routes/api/auth/[...all]/+server.ts`

```ts
const handleAuth: RequestHandler = async ({ request, platform }) => {
  const env = platform?.env;
  const check = validatePlatformEnv(env);
  if (!check.ok) return new Response(..., { status: 503 });  // missing bindings

  const auth = createAuth(env.DB, { BETTER_AUTH_SECRET, BETTER_AUTH_URL });
  return auth.handler(request);
};
export const GET = handleAuth;
export const POST = handleAuth;
```

The `[...all]` catchall means **every** URL under `/api/auth/` hits this handler. Better Auth routes internally:

- `POST /api/auth/sign-in/email` — used by our login page
- `POST /api/auth/sign-up/email` — used by `/signup`'s server action (via `auth.api.signUpEmail`, not HTTP)
- `GET /api/auth/get-session` — used by `getSession()` below
- plus `/sign-out`, `/reset-password`, OAuth routes (dormant), etc.

### 3. Session resolution in hooks — `src/hooks.server.ts` (`authHook`)

```ts
const authHook: Handle = async ({ event, resolve }) => {
  const env = event.platform?.env;
  if (!env || !event.locals.platformReady) {
    event.locals.user = null;
    event.locals.session = null;
    return resolve(event);
  }

  const auth = createAuth(env.DB, { BETTER_AUTH_SECRET, BETTER_AUTH_URL });
  const session = await auth.api.getSession({ headers: event.request.headers });

  event.locals.user = session?.user ?? null;
  event.locals.session = session?.session ?? null;
  return resolve(event);
};
```

This runs on every request. `getSession` reads the `better-auth.session_token` cookie from the headers, looks it up in the `sessions` table, joins the `users` row, and returns both — or `null`. The result lands on `locals`, so every downstream load/action just checks `locals.user`.

### 4. Enforcement — two layers

**Layer A — subdomain guard (`hooks.server.ts subdomainHook`).** Blocks CMS routes from `www.*` and www-only routes from `cms.*`. Defense-in-depth: even a misconfigured route can't leak the admin panel on the public domain.

**Layer B — auth guard (`src/routes/(cms)/+layout.server.ts`).**

```ts
if (url.pathname === "/login" || url.pathname === "/signup")
  return { user: locals.user };
if (!locals.user) throw redirect(302, "/login");
return { user: locals.user };
```

Every `(cms)` page except login/signup requires a user. Because SvelteKit runs layout loads before page loads, no CMS page server code ever sees `locals.user === null`.

### 5. Role-based permissions — `src/lib/server/auth/permissions.ts`

Better Auth doesn't opinionate on authorization — it just gives you `locals.user.role`. The permission helpers (`canEditArticle`, `canPublish`, `canDeleteArticle`, `canManageUsers`) live in that file, keyed off a 4-level hierarchy (`super_admin > admin > editor > author`). Article actions call them:

```ts
// src/routes/(cms)/articles/[id]/+page.server.ts
if (!canEditArticle(locals.user, existing.authorId)) return fail(403, ...);
if (!canPublish(user) && user.id !== existing.authorId) return fail(403, ...);
```

### 6. Bootstrap — first-admin dance

Sign-up is normally the wrong thing to expose on an admin panel. We expose it **conditionally**:

```ts
// src/lib/server/auth/bootstrap.ts
export async function hasAnySuperAdmin(d1: D1Database): Promise<boolean> { ... }
export async function promoteToSuperAdmin(d1, userId): Promise<void> { ... }
```

`/signup`'s load function 403s if any super_admin already exists. The action calls `auth.api.signUpEmail()` (which creates the user with the default `author` role), then immediately promotes them. After the first account, the route is locked forever. Login shows a "No admin exists yet" banner when `hasAnySuperAdmin()` returns false, so a fresh clone is self-guiding.

## Request flow — logging in

```
Browser                              SvelteKit Worker                     D1
───────                              ────────────────                     ──
POST /api/auth/sign-in/email   →     [catchall handler]
    { email, password }              createAuth(env.DB, ...)
                                     auth.handler(request)          →    SELECT user + account WHERE email = ?
                                       ├─ verify password hash      ←    row
                                       ├─ d1.batch([                →    INSERT session, token
                                       │    insert session,              returning cookie
                                       │    maybe refresh token ])
                                       └─ Set-Cookie: better-auth...
                               ←     200 { user, session }

GET  /dashboard                →     hooks: authHook
                                     auth.api.getSession(headers)   →    SELECT session JOIN user WHERE token = ?
                                                                    ←    row
                                     locals.user = session.user
                                     → (cms)/+layout.server.ts: user exists, allow
                                     → (cms)/dashboard/+page.server.ts runs
                               ←     HTML
```

Sign-up goes the same way except via `auth.api.signUpEmail()` (in-process, no HTTP round-trip, because it's called from our own server action).

## What we're deliberately **not** using (yet)

- **OAuth providers** — roadmap v1.1. The `accounts` table is there; we just haven't enabled `socialProviders` in `betterAuth(...)`.
- **Email verification** — `emailVerified` defaults to `true`-ish; we don't send verification email. When we add a mail provider (Resend, Postmark) we'll flip `requireEmailVerification: true`.
- **Password reset** — endpoints exist in the handler but we haven't surfaced a UI for them.
- **`better-auth/client`** — the JS client is fine but adds bundle weight. Our login page uses plain `fetch('/api/auth/sign-in/email')` via `login-submit.ts`; the signup page uses a SvelteKit form action. Both avoid shipping the client.

## The one footgun to remember

`createAuth` rebuilds per request because `env.DB` is request-scoped in Workers. That means **anything you want to live across requests (caches, etc.) has to live in the D1 row or a KV entry, not in a JS module-level variable.** Better Auth is already designed this way internally, but if you extend it with plugins, keep that in mind.

## Summary in one diagram

```
wrangler.toml                  hooks.server.ts              routes
─────────────                  ─────────────────            ───────
DB binding ──────┐             subdomainHook                (www)/*     → no auth needed
BETTER_AUTH_*    │             bindingsHook                 (cms)/login → public
secrets ─────────┤             configurationGuardHook       (cms)/signup → public, conditional (bootstrap)
                 │             paraglideLocaleHook          (cms)/**    → layout guard: locals.user required
                 ▼             authHook ──────┐                          │
                 createAuth(DB,...)           │                          ▼
                 ┌─────────────┴────┐         │              permissions.ts: canEditArticle, canPublish, ...
                 ▼                  ▼         ▼
              drizzleAdapter    /api/auth/*   locals.user = auth.api.getSession(headers)
                 │              (catchall)
                 ▼
              users · sessions · accounts · verifications  (D1)
```

Better Auth is intentionally the smallest, most boring piece — our code adds the role hierarchy, the bootstrap dance, and the subdomain enforcement; Better Auth just owns "is this cookie a valid session, and who does it belong to."

---

_Last touched: 2026-04-18 · Files referenced: `src/lib/server/auth/index.ts`, `src/lib/server/auth/bootstrap.ts`, `src/lib/server/auth/permissions.ts`, `src/hooks.server.ts`, `src/routes/api/auth/[...all]/+server.ts`, `src/routes/(cms)/+layout.server.ts`, `src/routes/(cms)/signup/+page.server.ts`._

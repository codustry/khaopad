# Deployment

> **Status: draft** — expanded reference for the config layers. The README has the short version.

## The four config layers

Config lives in four different places depending on what it is. Know which goes where:

| Layer                  | Where                                   | Scope       | Examples                                        |
| ---------------------- | --------------------------------------- | ----------- | ----------------------------------------------- |
| Bindings               | `wrangler.toml` `[[d1_databases]]` etc. | Per project | `DB`, `MEDIA_BUCKET`, `CONTENT_CACHE`           |
| Plain vars             | `wrangler.toml` `[vars]`                | Per project | `CONTENT_MODE`, locales, URLs                   |
| Cloudflare secrets     | `wrangler secret put`                   | Per project | `BETTER_AUTH_SECRET`, `GITHUB_TOKEN`            |
| GitHub Actions secrets | GitHub repo/org → Settings → Secrets    | CI only     | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |

**Secrets are never committed.** They live either in Cloudflare's encrypted secret store (runtime) or in GitHub's (CI). Plain vars in `wrangler.toml [vars]` are considered public — treat them like anything else in the repo.

## Why bindings aren't auto-generated

Khao Pad is a **template**, not a hosted service. Each fork provisions its own Cloudflare resources:

- `wrangler d1 create <db-name>` — returns a `database_id`
- `wrangler r2 bucket create <bucket>` — bucket name is the key, no ID
- `wrangler kv namespace create <name>` — returns an `id`

The IDs go into `wrangler.toml`. Your Worker code never sees account IDs or API tokens — Cloudflare injects the bindings into `platform.env` at runtime based on the binding names.

`pnpm setup` runs all three commands and prints the IDs to paste. For forks this is a one-time step per environment (prod, staging, etc.).

## The 503 config guard

What happens when a route loads but `platform.env` is missing a binding? Without protection, SvelteKit would throw at the first `env.DB.prepare(...)` call and render an opaque 500 stack trace. That's a terrible first-run experience for someone who just cloned the repo and ran `pnpm dev` without Wrangler.

Fix: `configurationGuardHook` in `src/hooks.server.ts` + `validatePlatformEnv` in `src/lib/server/config/platform-status.ts`. Flow:

1. `bindingsHook` calls `validatePlatformEnv(env)` — returns `{ ok: true }` or `{ ok: false, message, missing: [...] }`.
2. If not OK, we install null placeholder services on `locals` (so anything that reaches for `locals.content` gets a `throw new Error("not configured")` instead of a null-deref) and mark `locals.platformReady = false`.
3. `configurationGuardHook` sees the flag and returns a friendly 503 page — HTML for normal pages, JSON for API routes — listing exactly which vars/bindings are missing.

The exempt list (`/@`, `/_app`, `/node_modules`, `/src/`, `/favicon.png`) is for Vite's dev server so HMR still works while you fix your config.

## Local dev: two ways

```bash
pnpm wrangler:dev       # with D1/R2/KV simulators
pnpm dev                # plain Vite, no bindings
```

**`pnpm wrangler:dev` (recommended).** Wrangler spins up local simulators for D1 (SQLite file in `.wrangler/`), R2 (filesystem dir), and KV (filesystem dir). Reads `[vars]` from `wrangler.toml`. Reads secrets from `.dev.vars` (gitignored). The production `database_id` and KV `id` are ignored locally — resources are scoped to the binding name.

Create `.dev.vars` once:

```
BETTER_AUTH_SECRET=dev-local-only-not-a-real-secret
```

**`pnpm dev` (plain Vite).** No Cloudflare runtime at all. `platform.env` is undefined, so the 503 screen renders. Useful for working on purely client-side Svelte code without needing Wrangler, and for verifying the 503 page itself still looks right.

## CI deploy pipeline

`.github/workflows/deploy.yml` runs four sequential jobs: **gate → resolve-env → deploy → smoke-test**.

| Trigger                      | Target env   | Notes                                      |
| ---------------------------- | ------------ | ------------------------------------------ |
| Push to `main`               | `staging`    | Automatic after every merge                |
| Tag `v*.*.*` (e.g. `v1.2.0`) | `production` | Cut a release tag to promote               |
| `workflow_dispatch` (manual) | your choice  | Select `staging` or `production` in the UI |

**Jobs:**

1. **gate** — install, Paraglide compile, `svelte-check`, `eslint`, `prettier`, `vite build`. If any fail, nothing deploys. Same checks as `ci.yml` so PRs and deploys never disagree.
2. **resolve-env** — emits `environment` (`staging` / `production`) and `public_url` (from repo Variables) as step outputs.
3. **deploy** — attaches to a GitHub Environment (same name), applies pending D1 migrations via `wrangler d1 migrations apply --env <target>`, then `wrangler deploy --env <target>`. Add required-reviewer protection on the `production` environment in repo Settings → Environments to gate prod behind an approval.
4. **smoke-test** — curls the public URL up to 6× with 10s backoff. `2xx`, `3xx`, and `503` all count as "Worker responded" (503 = Khao Pad's config-guard page, which still means the Worker itself is live). `000`/`5xx-other` fails the run.

### Pre-reqs

**Secrets** (repo or org → Settings → Secrets):

- `CLOUDFLARE_API_TOKEN` — scopes: Workers Scripts Edit, D1 Edit, KV Edit, R2 Edit, Zone DNS Read
- `CLOUDFLARE_ACCOUNT_ID`

**Variables** (repo → Settings → Variables → Actions) — optional but recommended:

- `STAGING_PUBLIC_URL` (e.g. `https://staging-www.example.com`)
- `PRODUCTION_PUBLIC_URL` (e.g. `https://www.example.com`)

Without these, smoke-test emits a warning and exits 0 (so the pipeline still goes green on fresh forks before DNS is wired).

### Promotion flow

```
PR merged into main
     ↓
gate passes  →  deploy to staging  →  smoke-test staging
     ↓
manual QA on staging-*.example.com
     ↓
tag release:  git tag v1.2.0 && git push origin v1.2.0
     ↓
gate passes  →  (optional reviewer approval)  →  deploy to production  →  smoke-test prod
```

Need to roll back? Re-run the last good tag's deploy run in the Actions UI, or push a new tag pointing at the previous commit. D1 migrations are forward-only — down-migrations aren't generated, so plan schema changes to be additive where possible.

## First-deploy checklist

Shown in the README but worth repeating:

- [ ] `pnpm setup` ran and `wrangler.toml` has real `database_id` + KV `id`
- [ ] `BETTER_AUTH_SECRET` set via `wrangler secret put`
- [ ] `PUBLIC_SITE_URL`, `CMS_SITE_URL`, `BETTER_AUTH_URL` updated in `[vars]`
- [ ] `routes` block in `wrangler.toml` uncommented with real domain + zone
- [ ] Both subdomains point to the Worker in Cloudflare DNS
- [ ] GitHub org/repo has `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`
- [ ] `pnpm build` passes locally
- [ ] Migrations applied remote (CI will, or run `pnpm db:migrate:remote` manually)

After first deploy: visit `cms.your-domain.com` → see the "No admin exists yet" banner → `/signup` → bootstrap the first super_admin.

## Environments (prod/staging/dev)

Cloudflare Workers supports `[env.staging]` / `[env.production]` blocks in `wrangler.toml`, and Khao Pad now ships with both. Each env gets its own D1 database, R2 bucket, and KV namespace — **never share state across envs** or a destructive migration run against staging will wipe prod.

### Provisioning a new env

Everything under `[env.staging]` / `[env.production]` defaults to placeholder IDs (`STAGING_DB_ID`, `PRODUCTION_DB_ID`, etc). To fill them in:

```bash
# 1. Create the resources for that env
wrangler d1 create khaopad-db-staging
wrangler r2 bucket create khaopad-media-staging
wrangler kv namespace create khaopad-staging-cache

# 2. Paste the returned IDs into the matching [env.staging.*] blocks
# 3. Apply migrations once to seed the schema
wrangler d1 migrations apply khaopad-db --remote --env staging

# 4. Push secrets for that env
wrangler secret put BETTER_AUTH_SECRET --env staging
```

Repeat with `--env production` for prod. The top-level config in `wrangler.toml` (with `LOCAL_DB_ID` / `LOCAL_KV_ID`) is only used by `pnpm dev` and `pnpm wrangler:dev` locally — CI always deploys through a named env.

---

_Last touched: 2026-04-18 · Files: `wrangler.toml`, `.github/workflows/deploy.yml`, `src/lib/server/config/platform-status.ts`, `src/hooks.server.ts`, `scripts/setup.ts`._

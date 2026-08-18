# The Engine↔Theme Contract

**Version: 1.0.0** (`THEME_CONTRACT_VERSION` in `src/lib/theme-contract.ts` — that constant, not this file, is authoritative)

Khao Pad splits every install into two layers:

- the **engine** — routes, loads, commerce, auth, i18n plumbing, SEO. Upstream ships fixes here and every deployment receives them by merging.
- the **theme** — the deployment-owned look: chrome, homepage body, checkout field additions, head fragment, design tokens. A deployment owns these outright and upstream never touches them.

This document names exactly what sits on the theme side of that line. Everything listed here is a **promise**: it keeps existing and keeps its shape for as long as the MAJOR of the contract version holds. The promise is CI-enforced by `scripts/contract-guard.mjs` (see [Enforcement](#enforcement)).

The measured history behind each seam lives in the source files' own comments and in [#174](https://github.com/codustry/khaopad/issues/174); this file is the _what_, those are the _why_.

## Versioning rules

| Change                                | Bump      | Examples                                                                                          |
| ------------------------------------- | --------- | ------------------------------------------------------------------------------------------------- |
| Surface removed, renamed, or reshaped | **MAJOR** | dropping a chrome slot, renaming a props field, deleting a message key, removing a shop component |
| Surface added                         | **MINOR** | a new slot, a new optional props field, new message keys, a new building block                    |
| Documentation only                    | **PATCH** | clarifying this file                                                                              |

A MAJOR bump means every registered theme must be re-checked against the new surface. The guard makes this impossible to do by accident: a removal fails CI until `THEME_CONTRACT_VERSION` changes and the baseline is regenerated **in the same commit**.

## The contract surface

### 1. Chrome registry — `$lib/components/www/chrome.ts`

`setChrome({...})` called at module load from the registrations entry point. Slots:

| Slot     | Props type        | Replaces                                                  |
| -------- | ----------------- | --------------------------------------------------------- |
| `header` | `SiteHeaderProps` | the storefront header                                     |
| `footer` | `SiteFooterProps` | the storefront footer                                     |
| `home`   | `HomePageProps`   | the homepage body (route, load and SEO stay engine-owned) |

The props types' field lists are part of the contract (guard-pinned). Partial registration is supported — override one slot, keep the defaults for the rest.

Not overridable, deliberately: SEO tags, the cookie banner, the analytics beacon, the theme-token style. A theme cannot accidentally drop consent handling or canonical URLs.

### 2. Checkout slots — `$plugins/shop/checkout-extensions.ts`

`registerCheckoutSlots({...})`. Slots: `beforeContact`, `afterAddress`, `beforePayment`. Each component receives `CheckoutSlotProps` and may contribute a `billingAddress` (the guard pins its field list, including the tax-entity fields `entityName` / `taxId` / `branchCode`) and block submission via `setValidity`. Slots cannot touch line items, prices, totals, or the payment call.

### 3. Registration entry point — `$lib/plugins/registrations`

The one module guaranteed to load in **both** the server and the storefront client bundle. All `setChrome` / `registerCheckoutSlots` calls must run at module-load time from here (directly or via an import). Registering anywhere only the server loads produces SSR-paints-then-hydration-snaps-back — the failure mode is documented in `chrome.ts`.

### 4. Head fragment — `src/app.head.html`

A deployment-owned HTML fragment injected verbatim into `<head>` on every page (fonts, meta, verification tags). Inline `<script>` is unsupported (CSP nonces are substituted before injection — see `$lib/server/app-head.ts`).

### 5. Theme tokens — operator config, not code

Set in `/admin/settings`, validated server-side and again at render: `themePrimaryColor`, `themeBackgroundColor`, `themeForegroundColor`, `themeAccentColor`, `themeRadius`, `themeFontDisplay`, `themeLogoMediaId`. Emitted as CSS custom properties in an SSR-first inline style; unset tokens emit nothing.

### 6. Building blocks — `$lib/components/shop/*` and `$lib/components/www/*`

A custom home or chrome may import these (`ProductCard`, `HeaderSearch`, …) instead of rebuilding them. Their existence and names are guard-pinned; their props follow the same versioning rules as the slot props.

### 7. Paraglide message keys — `messages/en.json`

Deployment components call `m.key_name()` like engine code does. Policy: **a key, once shipped, is never removed or renamed within a MAJOR** — `en` is the reference locale and its key set is guard-pinned (all 826 and counting). Adding keys is MINOR. A key whose English _wording_ changes is a normal content edit, not a contract event.

### 8. Fork-side files

`README.md`, `wrangler.toml`, and everything under `src/lib/deployment/` (by convention) are deployment-owned: upstream never ships meaningful changes to them, and on merge conflict the deployment side wins. The engine repo keeps placeholder Cloudflare IDs in `wrangler.toml` for exactly this reason.

## Route precedence (add/add rule)

The engine owns every route it ships and reserves the right to add routes in future releases under its existing top-level namespaces: `/[locale]/…` public pages (`blog`, `products`, `collections`, `cart`, `checkout`, `account`, `search`, `careers`, `privacy-policy`), `/admin/*`, and `/api/*`.

A deployment adding its own routes must place them where upstream will not land: pick a distinct prefix (e.g. `/[locale]/x/…` or a brand-specific path). If an add/add collision still happens — the deployment created a route and a later engine release ships the same path — **the engine's route wins** and the deployment renames its own. That rule is what keeps `git merge upstream/main` mechanical; the alternative (deployment wins) would silently mask new engine features.

## Enforcement

`pnpm run guard:contract` (CI runs it next to `guard:css`):

- `theme-contract.baseline.json` is the **floor** — every item in it must still exist in the sources. Additions pass and are reported; this is what makes MINOR changes frictionless.
- Any missing item fails the build with the item named.
- To make an intentional MAJOR change: bump `THEME_CONTRACT_VERSION`, run `node scripts/contract-guard.mjs --update`, and commit both together with the code change — the version bump, the baseline diff, and the removal all appear in one reviewable commit.
- The guard also fails when the version constant and the baseline's recorded version disagree, so the baseline cannot be regenerated while quietly leaving the version untouched.

At each release, regenerate the baseline (`--update`) so the floor rises to match everything shipped since — additions become promises at release time, not at merge time.

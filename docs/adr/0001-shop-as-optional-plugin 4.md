# ADR 0001 — Shop as an optional plugin (BeamCheckout, PromptPay + card)

**Status:** Proposed
**Date:** 2026-05-03
**Owner:** Codustry
**Reviewers:** —
**Supersedes / superseded by:** —

## Context

Khao Pad (v2.0) is a website platform. It deliberately does _not_ try
to be Shopify — the milestone roadmap says so explicitly, and the
"who it's for" section names ecommerce as a non-goal.

But a real, working, Thai-localised ecommerce implementation already
exists downstream: [`codustry/bactrack-website`](https://github.com/codustry/bactrack-website)
runs on **bactrack.in.th** with:

- Product catalog (BACtrack breathalyzers) as **static data**, not
  D1 rows — `src/lib/data/products.ts` exports the `Product[]`
- Public store surface (`/{locale}/shop/cart`, `/checkout`, `/pay`,
  `/order`, `/lookup`) and product-detail pages
- CMS admin at `/admin/shop/{orders,discount-codes,affiliates}`
- Payments via **[BeamCheckout](https://beamcheckout.com/)** — Thai
  payment gateway with **PromptPay QR + credit card (3DS) + LINE
  Pay + TrueMoney**
- Money math in **integer satang** (never `float`) to keep arithmetic
  exact
- Discount codes (fixed / percent / free-shipping) with per-customer
  redemption tracking
- Affiliate referrals (ref code → attributed order → payout)
- Receipt email via Resend (reusing Khao Pad v2.0b's `resend-client`
  pattern)
- Order lookup by email + order number for guest checkout

The whole thing is ~8 D1 tables + 1 payment client + a handful of
routes. It sits _cleanly beside_ Khao Pad's existing v2.0 surface —
never modifies Khao Pad's core tables, never assumes a shop exists in
any core code path.

That structure — feature-complete, self-contained, non-invasive — is
exactly what a **plugin** should look like. This ADR proposes we
formalize that shape as the first real Khao Pad plugin, so any
Khao Pad-based site can add a small ecommerce surface without a fork.

## Decision

Introduce an **official plugin mechanism** for Khao Pad, and ship
`@khaopad/plugin-shop` as the first plugin, mirroring the BACtrack
implementation.

A Khao Pad plugin is:

1. **A separately-installable npm package** (or, for small teams, a
   local `src/plugins/<name>/` folder mirrored from upstream)
2. **A discoverable module** with a standard shape (below)
3. **Zero core surgery required** to install — the plugin registers
   itself; core code never `if`-branches on plugin presence

### Plugin contract

Each plugin exports a single default object:

```ts
// $lib/plugins/shop/index.ts
import type { KhaopadPlugin } from "$lib/plugins";
import { shopSchema } from "./schema";
import { shopRoutes } from "./routes";
import { shopAuditActions } from "./audit";
import { shopWebhookEvents } from "./events";
import { shopSidebar } from "./sidebar";
import { shopSettings } from "./settings";
import { shopI18n } from "./i18n";

export default {
  key: "shop",
  version: "0.1.0",
  displayName: "Shop (BeamCheckout)",
  description: "PromptPay + card checkout for Thailand",

  // Additive D1 tables — get concatenated into the operator's Drizzle
  // migrations at build time. Namespaced with `shop_` prefix so
  // there's no collision risk with core tables.
  schema: shopSchema,

  // Route directory (same shape as SvelteKit's `+page.svelte` etc.)
  // mounted at a fixed prefix. Public at /{locale}/shop/*; admin at
  // /admin/shop/*. Rewriting the mount point is not supported (keeps
  // URLs consistent for support/docs).
  routes: shopRoutes,

  // New AuditAction members. Merged into the core `AuditAction`
  // union so the /admin/audit viewer surfaces plugin activity.
  auditActions: shopAuditActions, // e.g. "order.paid", "order.refunded"

  // New WebhookEvent members. Merged so operators can subscribe to
  // shop events from the same /admin/webhooks UI.
  webhookEvents: shopWebhookEvents, // e.g. "order.paid", "order.shipped"

  // Sidebar entries. Automatic role-gating via the standard NavItem
  // shape.
  sidebar: shopSidebar, // "Shop" group with Orders, Discounts, Affiliates

  // /admin/settings card. Renders under a "Plugins" section with the
  // provider (Beam) credential inputs.
  settings: shopSettings,

  // i18n key set (EN + TH). Merged into the operator's paraglide
  // corpus at build time.
  i18n: shopI18n,

  // Optional lifecycle hooks. Fire on install (first migration) and
  // uninstall (config-driven). Best-effort; failures logged, never
  // aborted.
  onInstall?: async (ctx) => { /* seed default discount codes, etc. */ },
  onUninstall?: async (ctx) => { /* archive orders, keep D1 rows */ },
} satisfies KhaopadPlugin;
```

### What the plugin adds (schema)

Eight tables, all prefixed `shop_` for the plugin version (BACtrack
uses unprefixed for its single-project deploy — the plugin renames
them for clean namespacing):

- `shop_carts` — session-cookie-scoped, 30-day TTL
- `shop_cart_items` — line items with productSlug + qty + unit price
- `shop_orders` — post-checkout snapshot with `order_number`
  (BT-2604-0001-style human ID) + status enum + shipping address
- `shop_order_items` — line-item snapshot with product name + price
  frozen at checkout time (so old receipts stay truthful even if
  the product is delisted)
- `shop_discount_codes` — code + kind (`fixed`/`percent`/`free_shipping`)
  - amount + start/end/max_redemptions
- `shop_discount_redemptions` — one row per code use with cartId +
  orderId + redeemedAt (idempotency + reporting)
- `shop_affiliates` — ref_code + owner_email + commission_pct
- `shop_affiliate_referrals` — attribution edges + payout state

Money is stored as **INTEGER satang** everywhere. No floats. A
`Satang` branded type in `$lib/plugins/shop/money.ts` prevents
mixing with plain `number`.

### What the plugin adds (routes)

Public (mounted under `/{locale}/shop/`):

- `/cart` — view + edit line items, apply discount code
- `/checkout` — customer info + shipping address form
- `/pay` — payment method picker + PromptPay QR display + card 3DS
- `/order/[orderNumber]` — order status + receipt
- `/lookup` — guest lookup by email + order number

Admin (mounted under `/admin/shop/`):

- `/orders` — paginated queue with status tabs
  (pending → paid → shipped → delivered → refunded), per-order
  detail view with refund action
- `/discount-codes` — CRUD for codes
- `/affiliates` — CRUD for affiliates + payout ledger

API (mounted under `/api/shop/`):

- `POST /api/shop/cart` — add/update/remove line item
- `POST /api/shop/order` — create charge via Beam, return
  `chargeId` + `paymentMethodType` + QR payload or 3DS redirect URL
- `GET /api/shop/order/[orderNumber]` — poll payment status
- `POST /api/shop/webhook/beam` — Beam callback endpoint (signature
  verified)

### What the plugin adds (settings)

New card in `/admin/settings` under a "Plugins" section:

```
┌── Shop (BeamCheckout) ──────────────────────┐
│ Enabled       ▢ (default off — checkout    │
│                  form hidden site-wide      │
│                  when off)                  │
│ Beam merchant ID    _______________________  │
│ Beam API key        ●●●●●●●●●●●●●●●●●●●●●   │
│                     (stored as wrangler     │
│                     secret; masked in UI)   │
│ Resend key          ●●●●●●●●●●●●●●●●●●●●●   │
│                     (reuses newsletter's    │
│                     key if configured)      │
│ From address        orders@example.com      │
│ Shipping origin     Bangkok, TH             │
│ Currency            THB (fixed for v0.1)    │
└─────────────────────────────────────────────┘
```

The Beam API key uses the **same pattern as the newsletter Resend
key from v2.0b** — stored via `wrangler secret put SHOP_BEAM_KEY`,
never in D1, masked in the UI, redacted from all logs.

### What products look like (deliberately not in D1)

Products stay as **static TypeScript data** in the operator's
project, exported from `src/lib/products.ts`. The plugin doesn't
ship a product-catalog admin — that's out of scope for the "small
ecommerce" story.

```ts
// src/lib/products.ts (operator-owned)
import type { Product } from "@khaopad/plugin-shop";

export const products: Product[] = [
  {
    slug: "c6",
    name: "BACtrack C6",
    sku: "BT-C6",
    // ...
    priceTHB: 2999, // integer, VAT-inclusive
    availability: "in_stock",
    // ...
  },
];
```

**Why static data:** small-catalog sites (5–50 SKUs) don't need a
CRUD admin for products — the catalog changes rarely and the
developer already has git. The plugin reads `products.ts` from a
configurable path (`app.d.ts` type slot) and the operator ships
product updates via a git push. This matches the BACtrack pattern
exactly and keeps the plugin's D1 footprint minimal.

**Escape hatch:** an operator who _does_ want a CRUD admin can
implement `ProductProvider` (a small interface — `list()`,
`getBySlug()`) that reads from any source, including a new D1
table. The plugin only cares about the interface.

### What plugins do _not_ do (in v0.1)

- **No custom auth.** Plugins reuse Better Auth. Public plugin
  routes are anonymous; admin plugin routes get the standard
  `hasRole()` check.
- **No custom migrations pipeline.** Plugin schema is concatenated
  into Drizzle at build time. If a plugin needs a destructive
  migration mid-life, that's a manual operator step.
- **No cross-plugin dependencies.** Plugins can depend on core
  interfaces (`ContentProvider`, `dispatchEvent`, `logAudit`) but
  not on each other. Keeps the graph acyclic.
- **No runtime enable/disable.** Enabling a plugin requires a
  redeploy (adds routes + schema). Toggling `enabled=false` in
  settings hides the surface but keeps the tables + audit history.

## Rationale

**Why plugin-shape, not fork-shape?**

The BACtrack repo is currently a fork with a shop bolted on. That
works for BACtrack but leaks upstream sync pain: every Khao Pad
release (v2.0d webhooks, e.g.) needs a manual cherry-pick with two
different sets of `messages/*.json` to field-merge. A plugin
inverts that: \*\*BACtrack becomes `khaopad + @khaopad/plugin-shop

- config`**. Upstream releases hit BACtrack automatically via
`pnpm update`.

**Why BeamCheckout, specifically?**

BACtrack already validated Beam in production on bactrack.in.th.
Beam is the right choice for Thailand-first ecommerce:

- Native **PromptPay QR** (the dominant Thai payment method)
- Credit card with 3DS
- LINE Pay + TrueMoney available
- Basic-auth API (merchant_id + api_key) — simple to configure
- Refunds via API — matches the plugin's refund workflow
- Docs are decent, and there's a working reference implementation
  we can lift patterns from

For non-Thai markets, `plugin-shop` can grow additional payment
providers via a `PaymentProvider` interface. `BeamProvider` is the
v0.1 concrete implementation.

**Why not just fold the shop into Khao Pad core?**

Because most Khao Pad installs don't need ecommerce, and the shop
adds:

- 8 D1 tables (~10% more schema surface)
- 3 sidebar entries
- 5+ new routes
- A payment secret to manage
- ~4,000 lines of code

Making that opt-in preserves the "small, sharp tool" identity of
Khao Pad core. Sites that want commerce get it; sites that don't
never see it.

**Why not use Snipcart / Foxy / a third-party embedded checkout?**

Third-party checkouts work for global markets but not for Thailand:
they don't support PromptPay, don't understand Thai address format
(`thai-provinces.ts` from BACtrack has 77 provinces indexed), and
their pricing eats into small margins. Owning the checkout via Beam
keeps the Thai-first optionality that Khao Pad has had since day 1.

## Consequences

### Positive

- **Reduced fork burden for Codustry.** BACtrack becomes maintainable
  via `pnpm update`, not manual sync.
- **Reusable across future Codustry client sites** that need small
  ecommerce (breathalyzers today, other Thai brands tomorrow).
- **Community-visible pattern.** Sets the shape for future plugins
  (bookings, forums, ticketing, membership, etc.) without committing
  Khao Pad to shipping them.
- **BeamCheckout gets a permanent reference implementation.** Good
  for the ecosystem — Beam themselves may promote it.

### Negative

- **Plugin machinery is new code.** The route-mount + schema-concat
  - sidebar-merge glue needs to be built + tested. Estimate:
    ~2 weeks focused work for a first cut, with the shop plugin as
    the driving use case.
- **Plugin API is v0.1** — likely to change based on early plugin
  authors' needs. We should mark it experimental for at least two
  Khao Pad releases before promising stability.
- **Static products.ts is limiting** for larger catalogs. Anyone
  with >100 SKUs will want the escape-hatch `ProductProvider`
  path; documenting that clearly is important.

### Neutral

- **Naming.** `@khaopad/plugin-shop` is the working name. If Khao
  Pad itself is renamed (the "Quill" discussion elsewhere), the
  package name follows.
- **License.** Plugin ships MIT, same as core.

## Roadmap (proposed)

**v0.1 — Feature parity with BACtrack, minus catalog admin**

- All 8 shop tables (prefixed `shop_`)
- Public store surface (cart / checkout / pay / order / lookup)
- Admin surface (orders / discount codes / affiliates)
- Beam integration with PromptPay + card
- Receipt email via existing Resend integration
- Static products.ts contract with example
- Settings card + secret management
- Audit + webhook wiring
- Documentation: install guide + product-schema reference

**v0.2 — Provider abstraction**

- Extract `PaymentProvider` interface; ship `BeamProvider` +
  stub `StripeProvider`
- `ProductProvider` interface for D1-backed catalog escape hatch
- Multi-currency support (currency per product)

**v0.3+ (backlog)**

- Additional payment providers (Omise, Stripe, PayPal)
- Inventory tracking (per-slug stock levels)
- Multi-warehouse shipping origins
- Tax computation hooks
- Analytics integration (order revenue on dashboard)
- Cross-locale product data (currently EN + TH via static file)

## Alternatives considered

**A. Ship the shop in Khao Pad core**
Rejected: bloats install for the majority of sites that never need
commerce; couples Beam-specific choices to the core roadmap.

**B. Keep it as a fork template (like `khaopad-example`)**
Rejected: same upstream-sync burden BACtrack has today, multiplied
by every new Codustry client with commerce needs.

**C. Third-party embedded checkout (Snipcart, Foxy)**
Rejected: no PromptPay, no Thai address support, per-transaction
fees eat small-margin catalogs.

**D. Adopt an existing SvelteKit ecommerce framework (Vendure,
Medusa)**
Rejected: those are ecommerce-first with a CMS bolted on; we want
CMS-first with ecommerce bolted on. Also Node.js, not
Cloudflare-native. Also overkill for 5–50 SKUs.

## Open questions

1. **Package layout.** Publish to npm, or vendor as `src/plugins/`
   directories with a "sync from upstream" pattern like
   `khaopad-example` uses today?
2. **Plugin discovery.** Static registration (import in
   `src/hooks.server.ts`) or dynamic scanning of `src/plugins/`?
   Static is simpler and matches SvelteKit's compile-time
   philosophy; dynamic is friendlier for third-party plugins.
3. **How opinionated about products.ts location?** Fixed path
   (`src/lib/products.ts`) or configurable via a `khaopad.config.ts`?
4. **Should PromptPay QR regeneration be client-side or server-side?**
   BACtrack does server-side; client-side lets the QR render at
   higher DPI for retina displays but exposes the raw payload.
5. **Multi-tenant?** If a Codustry agency runs 5 client sites on one
   Khao Pad install (a future v3 backlog item), does each site get
   its own Beam merchant, or is the shop plugin single-tenant per
   install? Punting until multi-site itself is designed.

## References

- BACtrack downstream: `codustry/bactrack-website` (private)
- Live implementation: https://bactrack.in.th
- BeamCheckout docs: https://docs.beamcheckout.com
- Khao Pad v2.0b newsletter (source-of-truth for Resend integration
  pattern): [docs/MILESTONES.md § v2.0b](../MILESTONES.md#v20b--newsletter-fully-optional-double-opt-in--digest-sender)
- Khao Pad v2.0d webhooks (source-of-truth for HMAC + dispatch
  pattern): [docs/MILESTONES.md § v2.0d](../MILESTONES.md#v20d--webhooks--public-rest-api-shipped)

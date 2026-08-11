/**
 * @khaopad/plugin-shop — small ecommerce for Thailand-first sites.
 *
 * Ships as an optional plugin so sites that don't sell anything stay
 * lean. Uses the v3.0 plugin runtime.
 *
 * v3.1 scope (#56, in progress):
 *   - Product catalog + variants (this milestone, incremental sub-PRs)
 *
 * v3.2 scope (#57):
 *   - Cart, checkout, Beam payments, orders, shipping, tax, refunds
 *
 * Later:
 *   - v3.4 discounts + abandoned cart (#60)
 *   - v3.x Stripe + Omise adapters (#61)
 *
 * This first sub-PR (2a) ships only the plugin skeleton: registers
 * itself into the runtime, contributes an empty admin section, wires
 * up a placeholder route so the sidebar entry doesn't 404. The real
 * shop tables + admin CRUD land in follow-up sub-PRs.
 */
import { ShoppingCart, Package, Boxes, Ticket, BarChart3 } from "lucide-svelte";
import { defineKhaopadPlugin } from "$lib/plugins/types";
import {
  registerNavGroup,
  registerNavItem,
} from "$lib/components/admin/sidebar-nav";
import * as m from "$lib/paraglide/messages";
import { registerWebhookEvent } from "$lib/plugins/webhook-events";

// Register shop-owned webhook events at module load. Storefront
// integrations (inventory sync, analytics pipelines, order fulfilment
// bots) subscribe to these via /admin/webhooks.
registerWebhookEvent("product.created");
registerWebhookEvent("product.updated");
registerWebhookEvent("product.deleted");
registerWebhookEvent("inventory.adjusted");
registerWebhookEvent("collection.created");
registerWebhookEvent("collection.updated");
// Order lifecycle events (#113) — emitted by OrderService through the
// injected emitter; routes wire it to dispatchEvent(). Payloads carry
// order number, the three status axes, totals and channel — no
// customer PII (matches core article events' {id, slug} convention).
registerWebhookEvent("order.created");
registerWebhookEvent("order.paid");
registerWebhookEvent("order.fulfilled");
registerWebhookEvent("order.delivered");
registerWebhookEvent("order.cancelled");
registerWebhookEvent("order.refunded");

// Module-load registration — runs before the first render in both
// client and server bundles. See docs/plugin-authoring.md.
registerNavGroup({
  id: "shop",
  title: () => "Shop",
  items: [
    {
      href: "/admin/shop/products",
      label: () => "Products",
      icon: Package,
      roles: ["super_admin", "admin", "editor"],
    },
    {
      href: "/admin/shop/collections",
      label: () => "Collections",
      icon: Boxes,
      roles: ["super_admin", "admin", "editor"],
    },
    {
      href: "/admin/shop/orders",
      label: () => "Orders",
      icon: ShoppingCart,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/shop/discounts",
      label: () => "Discounts",
      icon: Ticket,
      roles: ["super_admin", "admin"],
    },
  ],
});

// D5: finance report lives in the MAIN group beside the dashboard (it
// reports on the whole store, not just the shop plugin's admin CRUD).
// registerNavItem appends after the core "main" items and is idempotent
// on href, so repeated plugin boots are safe.
registerNavItem("main", {
  href: "/admin/reports",
  label: m.shop_report_title,
  icon: BarChart3,
  roles: ["super_admin", "admin"],
});

export default defineKhaopadPlugin({
  slug: "shop",
  name: "Shop",
  version: "0.2.0",
  description:
    "Small ecommerce: products, variants, cart, checkout (BeamCheckout for Thailand)",
  async onInit(ctx) {
    // Register BeamCheckout provider at first-request time (needs env).
    // Skip silently when Beam credentials aren't set — the shop still
    // ships product catalog + cart, checkout will surface a helpful
    // 503 if a payment attempt fires without a configured provider.
    //
    // Only ENV credentials are read here. This module is reachable from
    // the browser bundle (sidebar-nav → registrations → this file), so it
    // must never import the secrets service — that would pull decryption
    // and the BETTER_AUTH_SECRET-derived key toward the client.
    //
    // DB-stored credentials are resolved per-request instead, in
    // `beam-config.server.ts`. That also keeps a rotated key effective
    // immediately, rather than pinning whatever existed at boot.
    const beamMerchantId = ctx.env.BEAM_MERCHANT_ID;
    const beamKey = ctx.env.BEAM_API_KEY;
    const beamWebhookSecret = ctx.env.BEAM_WEBHOOK_SECRET;
    if (beamMerchantId && beamKey && beamWebhookSecret) {
      const { BeamPaymentProvider } = await import("./beam");
      const { registerPaymentProvider } = await import("./payment");
      registerPaymentProvider(
        new BeamPaymentProvider({
          merchantId: beamMerchantId,
          apiKey: beamKey,
          webhookSecret: beamWebhookSecret,
          baseUrl: ctx.env.BEAM_BASE_URL,
        }),
      );
    }
  },
});

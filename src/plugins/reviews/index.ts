/**
 * @khaopad/plugin-reviews — product reviews with moderation (#160 D2).
 *
 * The second full reference plugin (after hello): exercises every v3.0
 * extension point end to end —
 * - Sidebar nav item appended to the SHOP group via `registerNavItem`
 *   (hello demonstrates `registerNavGroup`; this demonstrates joining
 *   an existing group registered by another plugin)
 * - Webhook event `review.approved` fired through the core dispatcher
 * - Table `product_reviews` via drizzle/0029_plugin_reviews_*.sql
 * - Admin route /admin/reviews (moderation queue, editor+)
 * - Storefront surface on the product page (approved reviews +
 *   submission form + aggregateRating JSON-LD)
 * - Audit actions "review.create" / "review.approve" / "review.reject"
 *   (open strings via the AuditAction widening)
 *
 * Depends on @khaopad/plugin-shop (reviews are of shop products and
 * verified-purchase matching reads shop_orders). Registration order in
 * registrations.ts/runtime.ts puts reviews AFTER shop so the "Shop"
 * nav group exists when registerNavItem targets it.
 */
import { Star } from "lucide-svelte";
import { defineKhaopadPlugin } from "$lib/plugins/types";
import { registerNavItem } from "$lib/components/admin/sidebar-nav";
import { registerWebhookEvent } from "$lib/plugins/webhook-events";

// Module-load registration — see hello/index.ts for the rationale
// (must run before first render in both client + server bundles).
registerWebhookEvent("review.approved");

registerNavItem("shop", {
  href: "/admin/reviews",
  label: () => "Reviews",
  icon: Star,
  // Editors moderate reviews, same trust level as comment moderation.
  roles: ["super_admin", "admin", "editor"],
});

export default defineKhaopadPlugin({
  slug: "reviews",
  name: "Reviews",
  version: "0.1.0",
  description:
    "Product reviews: moderated, verified-purchase badges, aggregateRating SEO",
});

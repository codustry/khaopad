/**
 * @khaopad/plugin-hello — reference plugin.
 *
 * The smallest plugin that exercises every extension point:
 * - Registers a sidebar nav group ("Hello")
 * - Registers a webhook event (`hello.pinged`)
 * - Ships a table (`hello_pings`) via drizzle/plugin_hello_0000_*.sql
 * - Owns routes under /admin/hello/
 * - Uses audit action "hello.pinged" (open string, works via 1a widening)
 *
 * Copy this folder to bootstrap a new plugin.
 */
import { CircleHelp } from "lucide-svelte";
import { defineKhaopadPlugin } from "$lib/plugins/types";
import { registerNavGroup } from "$lib/components/admin/sidebar-nav";
import { registerWebhookEvent } from "$lib/plugins/webhook-events";

// Module-load registration: side effects run when this file is imported
// (via src/lib/plugins/runtime.ts). Registries are idempotent, so
// re-imports are safe. This runs before the first request so the sidebar
// and webhook picker see plugin entries on the very first render.
registerWebhookEvent("hello.pinged");

registerNavGroup({
  id: "hello",
  title: () => "Plugins",
  items: [
    {
      href: "/admin/hello",
      label: () => "Hello",
      icon: CircleHelp,
      roles: ["super_admin", "admin", "editor", "author"],
    },
  ],
});

export default defineKhaopadPlugin({
  slug: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "Reference plugin — sends pings, tests the runtime",
  // No onInit needed — registration happens at module load above.
  // The optional onInit hook remains for plugins that need per-cold-start
  // work (e.g. warming a cache, seeding data conditionally).
});

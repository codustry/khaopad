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
import { defineKhaopadPlugin } from "$lib/plugins";
import { registerNavGroup } from "$lib/components/admin/sidebar-nav";
import { registerWebhookEvent } from "$lib/server/content/types";

export default defineKhaopadPlugin({
  slug: "hello",
  name: "Hello",
  version: "0.1.0",
  description: "Reference plugin — sends pings, tests the runtime",

  onInit() {
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
  },
});

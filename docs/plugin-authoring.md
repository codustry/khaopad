# Plugin authoring

Reference guide for extending Khao Pad with a plugin. As of v3.0, plugins live in-tree at `src/plugins/<slug>/`. Npm-package distribution (`@khaopad/plugin-*`) ships in a later release; the code contract is the same either way.

## Anatomy

```
src/plugins/<slug>/
  index.ts        # exports defineKhaopadPlugin({...})
  schema.ts       # Drizzle table definitions (optional)

src/routes/(admin)/admin/<slug>/
  +page.svelte    # admin page(s)
  +page.server.ts # loaders + form actions

drizzle/NNNN_plugin_<slug>_<desc>.sql   # migration file(s)
drizzle/meta/_journal.json               # add entry pointing at the migration
```

## Contract

```ts
import { defineKhaopadPlugin } from "$lib/plugins";

export default defineKhaopadPlugin({
  slug: "hello", // kebab-case, /^[a-z][a-z0-9-]*$/
  name: "Hello", // shown in Plugins UI (future)
  version: "0.1.0", // semver; wired for khaopadCompat later
  description: "...", // optional one-liner
  onInit(ctx) {
    // optional; runs once per Worker cold start
    // Per-cold-start work: warm caches, seed data conditionally.
    // NOT the place for sidebar/webhook registration — do those at
    // module load (see below).
  },
});
```

**`ctx.env`** gives you the Cloudflare bindings (`DB`, `MEDIA_BUCKET`, `CONTENT_CACHE`, ...) same shape as `App.Platform["env"]`.

## Registering into core

Do registrations at **module load** (top of `index.ts`), not inside `onInit`. This ensures the sidebar and webhook picker see plugin entries on the very first render — before any request.

```ts
import { registerNavGroup } from "$lib/components/admin/sidebar-nav";
import { registerWebhookEvent } from "$lib/server/content/types";
import { CircleHelp } from "lucide-svelte";

registerNavGroup({
  id: "hello",
  title: () => "Plugins",
  items: [
    { href: "/admin/hello", label: () => "Hello", icon: CircleHelp,
      roles: ["super_admin", "admin", "editor", "author"] },
  ],
});

registerWebhookEvent("hello.pinged");

export default defineKhaopadPlugin({ slug: "hello", ... });
```

All registries are **idempotent** — safe to import a plugin twice (won't happen in practice, but the belt-and-braces matters for HMR + test setups).

## Tables + migrations

Plugin schema goes in `src/plugins/<slug>/schema.ts` using Drizzle's `sqliteTable`. **Prefix every table with your slug** (`<slug>_*`) — soft convention, but keeps `SELECT * FROM sqlite_master` legible and avoids collisions with future core tables.

```ts
// src/plugins/hello/schema.ts
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const helloPings = sqliteTable("hello_pings", {
  id: text("id").primaryKey(),
  message: text("message").notNull(),
  createdAt: text("created_at").notNull(),
});
```

**Migrations share `drizzle/` with core.** Wrangler runs them in filename order, so your plugin's migration file needs a numeric prefix that comes after core's latest. Naming convention:

```
drizzle/<NNNN>_plugin_<slug>_<desc>.sql
```

Check the latest numeric prefix in `drizzle/`, add 1, use that. Also add a matching entry to `drizzle/meta/_journal.json` so drizzle-kit tracks it:

```json
{
  "idx": 12,
  "version": "6",
  "when": 1785138000000,
  "tag": "0012_plugin_hello_pings",
  "breakpoints": true
}
```

Run `pnpm run db:migrate` (local) or `pnpm run db:migrate:remote` (prod) to apply.

## Routes

Plugin admin routes live under `src/routes/(admin)/admin/<slug>/` — same filesystem convention as core. Import your plugin's schema via the `$plugins` alias:

```ts
// src/routes/(admin)/admin/hello/+page.server.ts
import { drizzle } from "drizzle-orm/d1";
import { helloPings } from "$plugins/hello/schema";
import type { PageServerLoad } from "./$types";

export const load: PageServerLoad = async ({ platform }) => {
  const db = drizzle(platform!.env.DB);
  const pings = await db.select().from(helloPings).all();
  return { pings };
};
```

## Audit + webhooks

Plugin audit actions and webhook event names are open strings (the `KnownX` union is widened via `& (string & {})`). Just call `logAudit(env.DB, userId, "myplugin.action", entityId)` — TypeScript accepts it. Convention: `<slug>.<verb>` (e.g. `hello.pinged`, `shop.order.paid`).

For the webhook picker to show your event in `/admin/webhooks`, register it at module load:

```ts
import { registerWebhookEvent } from "$lib/server/content/types";
registerWebhookEvent("hello.pinged");
```

Then fire it from your action:

```ts
import { dispatchEvent } from "$lib/server/webhooks";
await dispatchEvent(env, { event: "hello.pinged", payload: { id, message } });
```

## Optional (opt-in) plugins

A plugin whose manifest declares `optional: true` is **installed but not
active** until an operator switches it on in **Settings → Features**.
Default is OFF (#193).

```ts
export default defineKhaopadPlugin({
  slug: "shop",
  name: "Shop",
  version: "0.3.0",
  optional: true, // off until an operator enables it
});
```

Use it for anything a site might not want at all. The motivating case:
a deployment that sells nothing still saw **Shop → Products**, found it
empty, and read it as broken data — and creating a product there writes
to `shop_products`, which that site's storefront never reads. An unused
module must be absent, not empty.

Three things follow automatically once the flag is set:

1. **Nav.** `registerNavGroup({ id: "<slug>", ... })` is gated because
   `plugin` defaults to the group id. An item a plugin appends into a
   **core** group (`registerNavItem("main", ...)`) is not covered by
   that — tag it explicitly:

   ```ts
   registerNavItem("main", { href: "/admin/reports", ..., plugin: "shop" });
   ```

2. **Dashboard panels + anything else server-side.** Ask the gate:

   ```ts
   import { isPluginEnabled } from "$lib/plugins/optional";
   import { getEnabledPlugins } from "$lib/server/plugins/enabled";

   const on = isPluginEnabled("shop", await getEnabledPlugins(locals.content));
   ```

3. **Routes.** Hiding nav is not a guard — a bookmark still reaches the
   page. Add a `+layout.server.ts` at the top of your route subtree:

   ```ts
   import { requirePluginEnabled } from "$lib/server/plugins/enabled";
   export const load = async ({ locals }) => {
     await requirePluginEnabled(locals.content, "shop"); // 404s while off
     return {};
   };
   ```

   `+server.ts` endpoints do **not** run layout loads — repeat the call
   inline there.

Registration itself still happens at **module load**, unchanged: it
cannot await a D1 read, and the sidebar must not render before plugin
groups exist. The enabled set is applied when the nav snapshot is taken
(`listNavGroups(enabledPlugins)`), fed by the admin layout's load — so
SSR and hydration filter the same static registry with the same array.

Also add the slug to `OPTIONAL_PLUGIN_SLUGS` in
`src/lib/plugins/optional.ts`. That list is a hand-maintained mirror of
the manifests (it must stay free of `lucide-svelte` so the client bundle
and unit tests can import it); `optional-plugins.node.test.ts` pins the
two in sync.

Registered slugs live in site settings under `enabledPlugins`, so
switching a plugin on takes effect on the next request — no redeploy.

## Enabling a plugin

Add its default export to `enabledPlugins` in `src/lib/plugins/runtime.ts`:

```ts
import hello from "$plugins/hello";
import shop from "$plugins/shop"; // when it exists

const enabledPlugins: KhaopadPlugin[] = [hello, shop];
```

Removing a plugin is the mirror move: remove the import + entry. Migration data stays on disk unless you also drop the tables (opt-in — plugins don't ship down migrations in v3.0).

## Uninstall & data retention

**Removing a plugin leaves its tables + data intact.** This is deliberate — data loss on uninstall is worse than orphaned tables. If you want to reclaim the space, write a manual `DROP TABLE` migration and apply it via `wrangler d1 execute`.

Future v3.5: `pnpm khaopad plugin remove <slug> --drop-data` will offer the destructive path with a confirm prompt.

## Testing

The plugin acceptance test lives with the reference plugin. Copy `src/plugins/hello/` to bootstrap your own — it exercises every extension point (sidebar, webhook, audit, table, migration, route).

To manually verify: `pnpm run dev`, login as super_admin, visit `/admin/hello`, send a ping, check `/admin/audit` for the `hello.pinged` row.

## Roadmap (not shipped yet)

- **`pnpm khaopad plugin list|install|remove` CLI** — v3.5
- **`khaopadCompat` peer-dep check** at install time — v3.5
- **npm package discovery** via `package.json`'s `khaopad.plugins` field — v3.5
- **Per-plugin settings cards** in `/admin/settings` — deferred until a real plugin needs it. The generic on/off switch (Settings → Features) shipped in #193.
- **i18n key merging** so plugins can ship their own paraglide messages — deferred

See [docs/PLUGINS.md](./PLUGINS.md) for the curated list of shipped plugins.

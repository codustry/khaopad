# Plugins

Curated list of plugins for Khao Pad. See [docs/plugin-authoring.md](./plugin-authoring.md) for the plugin contract.

## Official plugins

| Plugin | Purpose | Status |
|---|---|---|
| `@khaopad/plugin-hello` (in-tree at `src/plugins/hello/`) | Reference plugin — exercises every extension point (sidebar, migration, route, audit, webhook) | 🟢 Ships with v3.0 |
| `@khaopad/plugin-shop` (in-tree at `src/plugins/shop/`) | Small ecommerce for Thailand-first sites: products, variants, cart, BeamCheckout | 🟡 v3.1 in progress — skeleton merged, catalog + admin CRUD next ([#56](https://github.com/codustry/khaopad/issues/56)) |
| `@khaopad/plugin-reviews` | Product reviews with moderation, star ratings, `AggregateRating` JSON-LD | 🟡 Planned v3.4 ([#60](https://github.com/codustry/khaopad/issues/60)) |

## Community plugins

_None yet._ To submit yours: open a PR adding a row to this table with your plugin name, description, npm link (when applicable), and `khaopadCompat` version range.

## Compatibility

Plugins declare a `khaopadCompat` range in their `package.json`:

```json
{
  "khaopad": {
    "compat": ">=3.0 <4"
  }
}
```

The `pnpm khaopad plugin install` command (v3.5+) will warn on mismatch. Until then, this is honor-system — check the plugin's README before installing.

## Distribution model (v3.0)

Plugins live **in-tree** at `src/plugins/<slug>/`. This is deliberate — real npm-package distribution ships in v3.5, once the plugin runtime has proven itself with a real second plugin (the shop). Doing distribution before there's a second plugin would be YAGNI.

If you're authoring a plugin now: fork Khao Pad, add your plugin to `src/plugins/<your-slug>/`, register it in `src/lib/plugins/runtime.ts`, and rebase on upstream as it releases. When v3.5 lands, extracting to a standalone npm package is a folder move.

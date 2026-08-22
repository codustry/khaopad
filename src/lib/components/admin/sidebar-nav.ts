import type { ComponentType } from "svelte";
import type { Pathname } from "$app/types";
import {
  LayoutDashboard,
  FileText,
  FilePlus,
  Image as ImageIcon,
  Database,
  Folder,
  Menu as MenuIcon,
  Tag,
  Users,
  Settings,
  ScrollText,
  Puzzle,
  Inbox,
  Mail,
  MessageSquare,
  Webhook,
  KeyRound,
  Ruler,
  Plug,
  UserCircle,
} from "lucide-svelte";
import * as m from "$lib/paraglide/messages";
import { isPluginEnabled } from "$lib/plugins/optional";

export type NavItem = {
  href: Pathname;
  /** Localized label (called at render time) */
  label: () => string;
  icon: ComponentType;
  /** Roles that can see this item. Empty = visible to everyone signed in. */
  roles?: ReadonlyArray<"super_admin" | "admin" | "editor" | "author">;
  /**
   * Owning plugin slug (#193). When the slug names an OPTIONAL plugin,
   * the entry is hidden unless the site enabled it. Set this on items a
   * plugin appends to a group it does not own — e.g. shop's
   * `/admin/reports` in the core "main" group, which otherwise survives
   * hiding the Shop group.
   */
  plugin?: string;
};

export type NavGroup = {
  /** Stable key used for localStorage open/close state */
  id: string;
  /** Localized group title (shown above items, hidden in collapsed mode) */
  title: () => string;
  items: ReadonlyArray<NavItem>;
  /**
   * Owning plugin slug (#193). Hides the whole group (title + items)
   * while an optional plugin is switched off. Defaults to the group id
   * on registration, which is the plugin slug by convention — so a
   * plugin group needs no extra wiring to be gateable.
   */
  plugin?: string;
};

/**
 * Runtime nav registry.
 *
 * Core groups + items are seeded at module load (below). Plugins call
 * `registerNavGroup()` or `registerNavItem()` at boot to contribute
 * their own entries — plugin groups appear after core groups in the
 * sidebar; plugin items appended to an existing group appear after
 * that group's core items.
 *
 * The Map preserves insertion order (ES2015+ guarantee) so ordering
 * is stable + predictable. `listNavGroups()` returns a fresh snapshot
 * on each call — do NOT hold onto the reference across plugin
 * registrations, or you'll miss late-registering plugins.
 */
type RegistryEntry = {
  title: () => string;
  items: NavItem[];
  /** Owning plugin slug — see NavGroup.plugin (#193). */
  plugin?: string;
};

/**
 * Lazily-initialized so registration cannot depend on module evaluation
 * ORDER.
 *
 * This file imports `$lib/plugins/registrations` at the bottom as a
 * side effect, so plugin `registerNavGroup()` calls run during this
 * module's own initialization. A bundler is free to hoist those calls
 * above a top-level `const registry = new Map()`, at which point every
 * request throws:
 *
 *   TypeError: Cannot read properties of undefined (reading 'get')
 *       at registerNavGroup (sidebar-nav.js)
 *
 * That is not hypothetical — it took the demo deployment down with a
 * Worker 1101 on every route, including /api/health, after an unrelated
 * icon import shifted the import graph enough to change the order.
 *
 * Reading through this accessor makes the order irrelevant: whoever
 * touches the registry first creates it.
 */
// `var`, deliberately — NOT `let`. This is the one case where var is
// correct and let is a bug.
//
// `let` is block-scoped and lives in the Temporal Dead Zone until its
// declaration executes: touching it before then throws
// `ReferenceError: Cannot access '_registry' before initialization`.
// `var` is hoisted and initialized to `undefined`, so the guard below
// simply sees undefined and creates the Map.
//
// That matters because this module imports `$lib/plugins/registrations`
// as a side effect at the bottom of the file, and a bundler is free to
// hoist those plugin registration calls ABOVE this declaration. It did:
// production minified the shop plugin's registerPaymentProvider call
// directly before `let pe;` (this variable), so every admin page threw
// on hydration and rendered "500 Internal Error".
//
// The lazy accessor added after the earlier outage fixed the Map being
// undefined, but not the TDZ on the binding itself — the accessor cannot
// run at all if reaching the variable throws. `var` closes that gap.
//
// eslint-disable-next-line no-var
var _registry: Map<string, RegistryEntry> | undefined;
function registry(): Map<string, RegistryEntry> {
  if (!_registry) _registry = new Map<string, RegistryEntry>();
  return _registry;
}

/**
 * Register a new nav group. Idempotent on id — a second call with the
 * same id updates the title (last write wins) but preserves items.
 * Plugins wanting to contribute to an existing core group should use
 * `registerNavItem()` instead.
 */
export function registerNavGroup(group: NavGroup): void {
  const existing = registry().get(group.id);
  if (existing) {
    existing.title = group.title;
    // Merge items — new ones appended, preserving core order.
    for (const item of group.items) {
      if (!existing.items.some((i) => i.href === item.href)) {
        existing.items.push(item);
      }
    }
    return;
  }
  registry().set(group.id, {
    title: group.title,
    items: [...group.items],
    // Default the owner to the group id: plugin groups are named after
    // their slug by convention (`src/plugins/<slug>` → group id
    // `<slug>`), so an optional plugin is gated without opting in to
    // extra wiring. Core group ids ("main", "taxonomy", "admin") are
    // not optional slugs, so this is inert for them.
    plugin: group.plugin ?? group.id,
  });
}

/**
 * Append a nav item to an existing group. Silently no-ops if the
 * group doesn't exist — plugins should register their group first
 * (or accept that their items will only appear when the group
 * they targeted is registered by someone else).
 *
 * Duplicate items (same href) are ignored — safe to call at every
 * plugin boot.
 */
export function registerNavItem(groupId: string, item: NavItem): void {
  const group = registry().get(groupId);
  if (!group) return;
  if (group.items.some((i) => i.href === item.href)) return;
  group.items.push(item);
}

/**
 * Snapshot of current nav groups. Called by Sidebar.svelte on each
 * render (Svelte re-runs the derived that reads it whenever
 * dependencies change). Returns groups in registration order.
 *
 * `enabledPlugins` (#193) is the operator's opt-in set, read from site
 * settings and threaded down through the admin layout's data. Groups
 * and items owned by an OPTIONAL plugin that is not in the set are
 * dropped from the snapshot.
 *
 * ## Why filter here rather than skip registration
 *
 * Registration happens at MODULE LOAD, in both bundles, before any
 * request — it cannot await a D1 read, and making it async would mean
 * the sidebar renders before plugin groups exist (the bug the
 * side-effect import at the bottom of this file exists to prevent).
 * Filtering a fully-populated registry at render time keeps
 * registration synchronous and order-independent, and — crucially —
 * makes SSR and hydration agree: both sides filter the same static
 * registry with the same set, delivered as page data.
 *
 * Omitting the argument returns everything, so callers that genuinely
 * want the installed set (structural tests, the future Plugins page)
 * are unaffected.
 */
export function listNavGroups(
  enabledPlugins?: ReadonlyArray<string> | null,
): ReadonlyArray<NavGroup> {
  const gate = (owner: string | undefined): boolean =>
    // No argument at all = "don't gate", distinct from an empty array,
    // which means "nothing optional is enabled".
    enabledPlugins === undefined ||
    isPluginEnabled(owner ?? "", enabledPlugins);

  return Array.from(registry().entries())
    .filter(([, entry]) => gate(entry.plugin))
    .map(([id, { title, items, plugin }]) => ({
      id,
      title,
      plugin,
      // Items carry their own owner so a plugin that appends into a
      // CORE group (shop's /admin/reports in "main") is gated too —
      // hiding the Shop group alone would leave that entry behind.
      items: items.filter((it) => gate(it.plugin)) as ReadonlyArray<NavItem>,
    }));
}

// ─── Core registration ─────────────────────────────────────────
// Core groups + items registered at module load. Order determines
// sidebar order; plugin groups will render after these.
//
// Plugin registrations happen via the side-effect import at the
// bottom of this file — after core is in place, so plugin groups
// slot in below core groups.

registerNavGroup({
  id: "main",
  title: m.cms_app_name,
  items: [
    { href: "/admin/dashboard", label: m.cms_dashboard, icon: LayoutDashboard },
    { href: "/admin/articles", label: m.cms_articles, icon: FileText },
    {
      href: "/admin/pages",
      label: m.cms_pages,
      icon: FilePlus,
      roles: ["super_admin", "admin", "editor"],
    },
    { href: "/admin/media", label: m.cms_media, icon: ImageIcon },
    {
      href: "/admin/navigation",
      label: m.cms_navigation,
      icon: MenuIcon,
      roles: ["super_admin", "admin", "editor"],
    },
  ],
});

registerNavGroup({
  id: "taxonomy",
  title: m.cms_categories,
  items: [
    {
      // Phase 4 (#68): user-defined content types. Editors see this too
      // (#125): the entry-editing routes beneath the index already admit
      // editors, but the only link into the area was admin-gated — so
      // the registry was admin-only in practice regardless of the route
      // guards. The index now renders read-only for editors; DEFINING a
      // type (a schema change) remains admin-gated at the action level.
      href: "/admin/content",
      label: () => "Content types",
      icon: Database,
      roles: ["super_admin", "admin", "editor"],
    },
    {
      // Phase 3 (#88/#130): typed spec/attribute definitions. Editors can
      // view; create/delete actions are admin-gated server-side.
      href: "/admin/specs",
      label: () => "Specs",
      icon: Ruler,
      roles: ["super_admin", "admin", "editor"],
    },
    { href: "/admin/categories", label: m.cms_categories, icon: Folder },
    { href: "/admin/tags", label: m.cms_tags, icon: Tag },
    {
      href: "/admin/blocks",
      label: m.cms_blocks,
      icon: Puzzle,
      roles: ["super_admin", "admin", "editor"],
    },
    {
      href: "/admin/forms",
      label: m.cms_forms,
      icon: Inbox,
      roles: ["super_admin", "admin", "editor"],
    },
    {
      href: "/admin/comments",
      label: m.cms_comments,
      icon: MessageSquare,
      roles: ["super_admin", "admin", "editor"],
    },
  ],
});

registerNavGroup({
  id: "admin",
  title: m.cms_admin,
  items: [
    {
      // Self-service profile + password change. Deliberately has NO
      // `roles` restriction: every staff role must be able to change
      // its own password, and an author — the weakest staff role —
      // cannot reach /admin/users at all. Restricting this entry would
      // recreate the bug it fixes. The route is still session-gated by
      // the admin layout, which 403s `customer` accounts.
      href: "/admin/profile",
      label: m.cms_profile,
      icon: UserCircle,
    },
    {
      href: "/admin/users",
      label: m.cms_users,
      icon: Users,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/audit",
      label: m.cms_audit,
      icon: ScrollText,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/subscribers",
      label: m.cms_subscribers,
      icon: Mail,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/webhooks",
      label: m.cms_webhooks,
      icon: Webhook,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/api-keys",
      label: m.cms_api_keys,
      icon: KeyRound,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/settings/secrets",
      label: () => "Credentials",
      icon: KeyRound,
      // super_admin only — these keys create charges and issue refunds.
      // Deliberately narrower than site settings, which admits `admin`.
      roles: ["super_admin"],
    },
    {
      // #160 Phase E — commerce-network pairing (Tonbab sync). Guide +
      // live status only; the secret VALUES stay on the super_admin
      // Credentials page.
      href: "/admin/settings/connections",
      label: m.cms_connections,
      icon: Plug,
      roles: ["super_admin", "admin"],
    },
    {
      href: "/admin/settings",
      label: m.cms_settings,
      icon: Settings,
      roles: ["super_admin", "admin"],
    },
  ],
});

/**
 * @deprecated Use `listNavGroups()` — the direct array export captured
 * groups at module load time and missed plugin registrations that
 * happened after import. Kept as a live getter (Proxy) so old imports
 * still work and always see the current set.
 */
export const navGroups = new Proxy([] as NavGroup[], {
  get(_t, prop, receiver) {
    return Reflect.get(listNavGroups(), prop, receiver);
  },
  has(_t, prop) {
    return Reflect.has(listNavGroups(), prop);
  },
  ownKeys(_t) {
    return Reflect.ownKeys(listNavGroups());
  },
  getOwnPropertyDescriptor(_t, prop) {
    return Object.getOwnPropertyDescriptor(listNavGroups(), prop);
  },
});

// ─── Plugin side-effect imports ─────────────────────────────────
// Importing this at the BOTTOM (after core registrations above) means
// plugin groups slot in below core groups in insertion order. This
// import runs in BOTH client + server bundles because sidebar-nav.ts
// is imported by Sidebar.svelte (a browser component) — which was the
// original bug fix: plugin registrations that only ran server-side
// vanished after client hydration.
import "$lib/plugins/registrations";

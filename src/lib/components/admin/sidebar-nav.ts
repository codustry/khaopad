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
} from "lucide-svelte";
import * as m from "$lib/paraglide/messages";

export type NavItem = {
  href: Pathname;
  /** Localized label (called at render time) */
  label: () => string;
  icon: ComponentType;
  /** Roles that can see this item. Empty = visible to everyone signed in. */
  roles?: ReadonlyArray<"super_admin" | "admin" | "editor" | "author">;
};

export type NavGroup = {
  /** Stable key used for localStorage open/close state */
  id: string;
  /** Localized group title (shown above items, hidden in collapsed mode) */
  title: () => string;
  items: ReadonlyArray<NavItem>;
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
const registry = new Map<string, { title: () => string; items: NavItem[] }>();

/**
 * Register a new nav group. Idempotent on id — a second call with the
 * same id updates the title (last write wins) but preserves items.
 * Plugins wanting to contribute to an existing core group should use
 * `registerNavItem()` instead.
 */
export function registerNavGroup(group: NavGroup): void {
  const existing = registry.get(group.id);
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
  registry.set(group.id, {
    title: group.title,
    items: [...group.items],
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
  const group = registry.get(groupId);
  if (!group) return;
  if (group.items.some((i) => i.href === item.href)) return;
  group.items.push(item);
}

/**
 * Snapshot of current nav groups. Called by Sidebar.svelte on each
 * render (Svelte re-runs the derived that reads it whenever
 * dependencies change). Returns groups in registration order.
 */
export function listNavGroups(): ReadonlyArray<NavGroup> {
  return Array.from(registry.entries()).map(([id, { title, items }]) => ({
    id,
    title,
    items: [...items] as ReadonlyArray<NavItem>,
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
      // Phase 4 (#68): user-defined content types. Admin-only because
      // defining a type changes what the public API exposes.
      href: "/admin/content",
      label: () => "Content types",
      icon: Database,
      roles: ["super_admin", "admin"],
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

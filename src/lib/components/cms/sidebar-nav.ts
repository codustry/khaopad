import type { ComponentType } from "svelte";
import {
  LayoutDashboard,
  FileText,
  Image as ImageIcon,
  Folder,
  Tag,
} from "lucide-svelte";
import * as m from "$lib/paraglide/messages";

export type NavItem = {
  href: string;
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

// NOTE: /cms/users and /cms/settings are not implemented yet (slated for
// a future milestone). They were removed from the sidebar to avoid 404s.
// Re-add them once the corresponding +page.svelte files exist.
export const navGroups: ReadonlyArray<NavGroup> = [
  {
    id: "main",
    title: m.cms_app_name,
    items: [
      { href: "/cms/dashboard", label: m.cms_dashboard, icon: LayoutDashboard },
      { href: "/cms/articles", label: m.cms_articles, icon: FileText },
      { href: "/cms/media", label: m.cms_media, icon: ImageIcon },
    ],
  },
  {
    id: "taxonomy",
    title: m.cms_categories,
    items: [
      { href: "/cms/categories", label: m.cms_categories, icon: Folder },
      { href: "/cms/tags", label: m.cms_tags, icon: Tag },
    ],
  },
];

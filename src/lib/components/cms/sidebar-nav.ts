import type { ComponentType } from "svelte";
import {
  LayoutDashboard,
  FileText,
  Image as ImageIcon,
  Folder,
  Tag,
  Users,
  Settings,
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
  {
    id: "admin",
    title: m.cms_admin,
    items: [
      {
        href: "/cms/users",
        label: m.cms_users,
        icon: Users,
        roles: ["super_admin", "admin"],
      },
      {
        href: "/cms/settings",
        label: m.cms_settings,
        icon: Settings,
        roles: ["super_admin", "admin"],
      },
    ],
  },
];

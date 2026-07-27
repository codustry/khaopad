import type { ComponentType } from "svelte";
import {
  LayoutDashboard,
  FileText,
  FilePlus,
  Image as ImageIcon,
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
  },
  {
    id: "taxonomy",
    title: m.cms_categories,
    items: [
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
  },
  {
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
  },
];

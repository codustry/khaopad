import type { UserRole, AuthUser } from "./types";

/**
 * Role hierarchy: super_admin > admin > editor > author
 */
const ROLE_LEVEL: Record<UserRole, number> = {
  super_admin: 4,
  admin: 3,
  editor: 2,
  author: 1,
};

/** Check if user has at least the given role level */
export function hasRole(user: AuthUser | null, minRole: UserRole): boolean {
  if (!user) return false;
  return ROLE_LEVEL[user.role] >= ROLE_LEVEL[minRole];
}

/** Check if user can manage other users (admin+) */
export function canManageUsers(user: AuthUser | null): boolean {
  return hasRole(user, "admin");
}

/** Check if user can manage site settings (admin+) */
export function canManageSettings(user: AuthUser | null): boolean {
  return hasRole(user, "admin");
}

/** Check if user can manage categories/tags (editor+) */
export function canManageTaxonomy(user: AuthUser | null): boolean {
  return hasRole(user, "editor");
}

/** Check if user can publish/unpublish any content (editor+) */
export function canPublish(user: AuthUser | null): boolean {
  return hasRole(user, "editor");
}

/** Check if user can edit a specific article */
export function canEditArticle(
  user: AuthUser | null,
  articleAuthorId: string,
): boolean {
  if (!user) return false;
  // Editor+ can edit any article, authors can only edit their own
  if (hasRole(user, "editor")) return true;
  return user.id === articleAuthorId;
}

/** Check if user can delete any content (admin+) */
export function canDeleteAny(user: AuthUser | null): boolean {
  return hasRole(user, "admin");
}

/** Check if user can delete a specific article */
export function canDeleteArticle(
  user: AuthUser | null,
  articleAuthorId: string,
): boolean {
  if (!user) return false;
  if (hasRole(user, "admin")) return true;
  return user.id === articleAuthorId;
}

/**
 * Check whether the acting user is allowed to change the role / delete the
 * target user. Enforces three rules on top of the basic "admin can manage
 * users" check:
 *
 *   1. You can't change your own role or delete yourself — guard against
 *      a super_admin accidentally locking themselves out.
 *   2. Only a super_admin can promote someone to super_admin or demote a
 *      super_admin to a lower role.
 *   3. A regular admin can only manage author/editor accounts, not other
 *      admins (prevents lateral demotions).
 *
 * The "at least one super_admin must remain" rule is enforced at the
 * action-handler level, where it can read the live row count.
 */
export function canManageUser(
  actor: AuthUser | null,
  target: { id: string; role: UserRole },
): boolean {
  if (!actor) return false;
  if (!canManageUsers(actor)) return false;
  if (actor.id === target.id) return false;
  if (target.role === "super_admin" && actor.role !== "super_admin") {
    return false;
  }
  if (actor.role === "admin" && target.role === "admin") return false;
  return true;
}

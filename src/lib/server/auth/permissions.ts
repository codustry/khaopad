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

/**
 * `customer` (v3.17 D1) is the storefront-shopper role created by the
 * email-OTP sign-in. It ranks BELOW `author`, so every `hasRole()` gate
 * on the admin surface (all of which require at least `author`, most
 * `editor`) excludes customers without further changes.
 */
export type UserRole =
  | "super_admin"
  | "admin"
  | "editor"
  | "author"
  | "customer";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  image: string | null;
  role: UserRole;
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  token: string;
  expiresAt: string;
}

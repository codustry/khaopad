import { describe, it, expect } from "vitest";
import { canManageSecrets, canManageSettings } from "./permissions";
import type { AuthUser } from "./types";

const user = (role: AuthUser["role"]) => ({ id: "u1", role }) as AuthUser;

describe("canManageSecrets", () => {
  it("allows only super_admin", () => {
    expect(canManageSecrets(user("super_admin"))).toBe(true);
    expect(canManageSecrets(user("admin"))).toBe(false);
    expect(canManageSecrets(user("editor"))).toBe(false);
    expect(canManageSecrets(user("author"))).toBe(false);
  });

  it("denies an unauthenticated user", () => {
    expect(canManageSecrets(null)).toBe(false);
  });

  it("is strictly narrower than canManageSettings", () => {
    // The whole point of a separate helper. If these ever converge, an
    // `admin` silently gains the ability to read/replace live payment
    // credentials — so assert the divergence, not just each value.
    expect(canManageSettings(user("admin"))).toBe(true);
    expect(canManageSecrets(user("admin"))).toBe(false);
  });
});

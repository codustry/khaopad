/**
 * v3.17 (#160 Phase D1) — customer role isolation.
 *
 * Customers share the Better Auth stack with the CMS, so the thing
 * standing between a shopper session and /admin is the role system.
 * These tests pin all three layers:
 *
 *   1. `hasRole` — `customer` ranks below `author`, the weakest staff
 *      role, so every existing admin gate already excludes it.
 *   2. The (admin) layout guard — a signed-in customer gets a hard 403
 *      on EVERY /admin route (the layout wraps them all), not a login
 *      redirect and not a rendered shell.
 *   3. The auth config — the email-OTP sign-in path mints `customer`,
 *      never the `author` default (which IS a staff role).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasRole } from "$lib/server/auth/permissions";
import type { AuthUser } from "$lib/server/auth/types";
import { load } from "./admin/+layout.server";

const R = (p: string) => new URL(p, import.meta.url).pathname;

function makeUser(role: AuthUser["role"]): AuthUser {
  return {
    id: "u-1",
    name: "Somsri",
    email: "somsri@example.com",
    emailVerified: true,
    image: null,
    role,
    createdAt: "2026-08-12T00:00:00.000Z",
    updatedAt: "2026-08-12T00:00:00.000Z",
  };
}

type LoadArgs = Parameters<typeof load>[0];
function callLayoutLoad(
  user: AuthUser | null,
  pathname = "/admin/dashboard",
  /** #193: the layout resolves the opt-in plugin set from settings. */
  settings: Record<string, unknown> = {},
) {
  return load({
    locals: { user, content: { getSettings: async () => settings } },
    url: new URL(`https://example.com${pathname}`),
  } as unknown as LoadArgs);
}

describe("customer role ranks below every staff gate", () => {
  it("fails hasRole for author and everything above", () => {
    const customer = makeUser("customer");
    for (const gate of ["author", "editor", "admin", "super_admin"] as const) {
      expect(hasRole(customer, gate), gate).toBe(false);
    }
  });

  it("staff roles still pass their own gates", () => {
    expect(hasRole(makeUser("author"), "author")).toBe(true);
    expect(hasRole(makeUser("editor"), "editor")).toBe(true);
  });
});

describe("(admin) layout guard", () => {
  it("403s a customer session on admin routes", async () => {
    for (const path of ["/admin/dashboard", "/admin/articles", "/admin"]) {
      let status: number | null = null;
      try {
        await callLayoutLoad(makeUser("customer"), path);
      } catch (err) {
        status = (err as { status?: number }).status ?? null;
      }
      expect(status, path).toBe(403);
    }
  });

  it("still redirects anonymous visitors to login (302, not 403)", async () => {
    let status: number | null = null;
    try {
      await callLayoutLoad(null);
    } catch (err) {
      status = (err as { status?: number }).status ?? null;
    }
    expect(status).toBe(302);
  });

  it("lets staff through", async () => {
    const result = await callLayoutLoad(makeUser("author"));
    // #193 added the opt-in plugin set to the payload; empty by
    // default, which is what a fresh install must see.
    expect(result).toEqual({ user: makeUser("author"), enabledPlugins: [] });
  });

  it("passes the operator's enabled plugin set down to the nav (#193)", () => {
    return expect(
      callLayoutLoad(makeUser("admin"), "/admin/dashboard", {
        enabledPlugins: ["shop"],
      }),
    ).resolves.toMatchObject({ enabledPlugins: ["shop"] });
  });
});

describe("auth config mints customer for the OTP flow only (source pins)", () => {
  const authSrc = readFileSync(R("../../lib/server/auth/index.ts"), "utf8");

  it("registers the emailOTP plugin with hashed storage", () => {
    expect(authSrc).toContain("emailOTP(");
    expect(authSrc).toContain('storeOTP: "hashed"');
  });

  it("assigns role customer keyed on the sign-in/email-otp path", () => {
    expect(authSrc).toContain('"/sign-in/email-otp"');
    expect(authSrc).toContain('role: "customer"');
    // The staff default must survive for every other create path.
    expect(authSrc).toContain('defaultValue: "author"');
  });
});

describe("phase D wiring (source pins)", () => {
  it("admin adjust-inventory fires back-in-stock notify on increase", () => {
    const src = readFileSync(
      R("./admin/shop/products/[id]/+page.server.ts"),
      "utf8",
    );
    expect(src).toContain("notifyBackInStock");
    expect(src).toMatch(/delta > 0/);
  });

  it("product page carries the capture form for sold-out variants", () => {
    const src = readFileSync(
      R("../(www)/[locale]/products/[slug]/+page.svelte"),
      "utf8",
    );
    expect(src).toContain("/api/shop/back-in-stock");
    expect(src).toContain("shop_bis_title");
  });

  it("checkout loads savedAddresses and prefills from them", () => {
    const server = readFileSync(
      R("../(www)/[locale]/checkout/+page.server.ts"),
      "utf8",
    );
    expect(server).toContain("savedAddresses");
    expect(server).toContain("listAddresses");
    const page = readFileSync(
      R("../(www)/[locale]/checkout/+page.svelte"),
      "utf8",
    );
    expect(page).toContain("data.savedAddresses");
  });

  it("account page is localized, noindexed, and never publicly cached", () => {
    const page = readFileSync(
      R("../(www)/[locale]/account/+page.svelte"),
      "utf8",
    );
    expect(page).toContain('content="noindex, follow"');
    expect(page).toMatch(/<title>\{m\./);
    expect(page).toContain("$lib/paraglide/messages");
    // Per-visitor page — must ride the no-store branch in cacheHook.
    const hooks = readFileSync(R("../../hooks.server.ts"), "utf8");
    const fnMatch = hooks.match(/function isShopFunnelPath[\s\S]*?\n\}/);
    const re = fnMatch?.[0].match(/\/(\^.*?)\/\.test/)?.[1];
    expect(re).toBeTruthy();
    expect(new RegExp(re!).test("/th/account")).toBe(true);
    expect(new RegExp(re!).test("/account")).toBe(true);
  });
});

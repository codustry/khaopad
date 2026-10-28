/**
 * v4.5.1 — order pages were readable by anyone holding a (sequential)
 * order number. These pin who may see an order, and that the three
 * routes which look orders up BY NUMBER all go through canViewOrder.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { Cookies } from "@sveltejs/kit";
import type { AuthUser, UserRole } from "$lib/server/auth/types";
import {
  ORDER_ACCESS_COOKIE,
  browserPlacedOrder,
  canViewOrder,
  grantOrderAccess,
} from "./order-access";

const SECRET = "test-secret-at-least-32-characters-long";

function jar(initial: Record<string, string> = {}): Cookies {
  const store = new Map(Object.entries(initial));
  return {
    get: (name: string) => store.get(name),
    getAll: () => [...store].map(([name, value]) => ({ name, value })),
    set: (name: string, value: string) => void store.set(name, value),
    delete: (name: string) => void store.delete(name),
    serialize: () => "",
  } as unknown as Cookies;
}

function user(role: UserRole, over: Partial<AuthUser> = {}): AuthUser {
  return {
    id: "u_1",
    name: "U",
    email: "someone@example.com",
    emailVerified: true,
    image: null,
    role,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const order = {
  orderNumber: "KP-2026-00001",
  email: "Buyer@Example.com",
  userId: null as string | null,
};

const view = (over: Partial<Parameters<typeof canViewOrder>[0]> = {}) =>
  canViewOrder({
    order,
    user: null,
    email: null,
    cookies: jar(),
    secret: SECRET,
    ...over,
  });

describe("canViewOrder", () => {
  it("refuses an anonymous visitor holding only the number", async () => {
    expect(await view()).toBe(false);
  });

  it("refuses any signed-in non-owner, customer or editor", async () => {
    expect(await view({ user: user("customer") })).toBe(false);
    expect(await view({ user: user("editor") })).toBe(false);
  });

  it("allows staff (admin+)", async () => {
    expect(await view({ user: user("admin") })).toBe(true);
    expect(await view({ user: user("super_admin") })).toBe(true);
  });

  it("allows the owning account by user id", async () => {
    expect(
      await view({
        order: { ...order, userId: "u_1" },
        user: user("customer"),
      }),
    ).toBe(true);
  });

  it("allows a VERIFIED account whose email matches, not an unverified one", async () => {
    const email = "buyer@example.com";
    expect(await view({ user: user("customer", { email }) })).toBe(true);
    expect(
      await view({ user: user("customer", { email, emailVerified: false }) }),
    ).toBe(false);
  });

  it("allows the order's email, case- and space-insensitively", async () => {
    expect(await view({ email: "  buyer@EXAMPLE.com " })).toBe(true);
    expect(await view({ email: "other@example.com" })).toBe(false);
    expect(await view({ email: "" })).toBe(false);
  });

  it("allows the browser that placed the order", async () => {
    const cookies = jar();
    await grantOrderAccess(cookies, SECRET, order.orderNumber);
    expect(await view({ cookies })).toBe(true);
  });
});

describe("order-access cookie", () => {
  it("cannot be minted without the secret", async () => {
    const forged = jar({ [ORDER_ACCESS_COOKIE]: `${order.orderNumber}.AAAA` });
    expect(await browserPlacedOrder(forged, SECRET, order.orderNumber)).toBe(
      false,
    );
  });

  it("does not carry over to another order number", async () => {
    const cookies = jar();
    await grantOrderAccess(cookies, SECRET, "KP-2026-00001");
    expect(await browserPlacedOrder(cookies, SECRET, "KP-2026-00002")).toBe(
      false,
    );
  });

  it("is refused under a different secret (rotation invalidates it)", async () => {
    const cookies = jar();
    await grantOrderAccess(cookies, SECRET, order.orderNumber);
    expect(
      await browserPlacedOrder(cookies, `${SECRET}-rotated`, order.orderNumber),
    ).toBe(false);
  });

  it("keeps at most 10 orders, newest first, without duplicates", async () => {
    const cookies = jar();
    for (let i = 1; i <= 12; i++) {
      await grantOrderAccess(cookies, SECRET, `KP-2026-${i}`);
    }
    await grantOrderAccess(cookies, SECRET, "KP-2026-12");
    const entries = cookies.get(ORDER_ACCESS_COOKIE)!.split(",");
    expect(entries).toHaveLength(10);
    expect(entries[0].startsWith("KP-2026-12.")).toBe(true);
    expect(await browserPlacedOrder(cookies, SECRET, "KP-2026-1")).toBe(false);
  });

  it("grants nothing when no secret is configured", async () => {
    const cookies = jar();
    await grantOrderAccess(cookies, undefined, order.orderNumber);
    expect(cookies.get(ORDER_ACCESS_COOKIE)).toBeUndefined();
    expect(await view({ cookies, secret: undefined })).toBe(false);
  });
});

describe("routes that look an order up by number", () => {
  const read = (p: string) =>
    readFileSync(new URL(`../../../routes/${p}`, import.meta.url), "utf8");

  it("the order page load and return action both check access", () => {
    const src = read("(www)/[locale]/order/[orderNumber]/+page.server.ts");
    expect(src.match(/canViewOrder\(/g)).toHaveLength(2);
    // The old shape: signed-in → no email filter, anonymous → optional one.
    expect(src).not.toMatch(/locals\.user \? undefined/);
  });

  it("paying by order number checks access", () => {
    const src = read("api/shop/checkout/pay/+server.ts");
    expect(src).toMatch(/canViewOrder\(/);
  });

  it("checkout/start grants the placing browser access", () => {
    const src = read("api/shop/checkout/start/+server.ts");
    expect(src).toMatch(/grantOrderAccess\(cookies, env\.BETTER_AUTH_SECRET/);
  });
});

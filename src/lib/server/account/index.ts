/**
 * Customer account module (v3.17 D1) — saved addresses CRUD + order
 * history for passwordless customer accounts.
 *
 * Order history is matched by EMAIL, not user id: guest checkout has
 * always keyed orders on `shop_orders.email`, and retrofitting a
 * user_id column would strand every pre-account order. The email match
 * is only safe because the OTP sign-in PROVES ownership of the
 * address — hence the hard `emailVerified` gate in
 * `listOrdersForCustomer`. An unverified user (impossible via the OTP
 * flow, but reachable if an admin hand-creates a row) sees nothing.
 */
import { drizzle } from "drizzle-orm/d1";
import { and, desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { customerAddresses } from "$lib/server/content/schema";
import type { CustomerAddress } from "$lib/server/content/schema";
import { shopOrders } from "$plugins/shop/schema-cart";
import type { ShopOrder } from "$plugins/shop/schema-cart";
import type { OrderAddress } from "$plugins/shop/order-service";

export type { CustomerAddress };

export type CustomerAddressInput = OrderAddress & { isDefault?: boolean };

const MAX_ADDRESSES_PER_USER = 20;

function validateAddress(input: OrderAddress): string | null {
  if (!input.name?.trim()) return "Name is required";
  if (!input.line1?.trim()) return "Address line is required";
  if (!input.city?.trim()) return "City is required";
  if (!input.postalCode?.trim()) return "Postal code is required";
  if (!/^[A-Za-z]{2}$/.test(input.countryCode?.trim() ?? "")) {
    return "Country must be a 2-letter code";
  }
  return null;
}

/** List a user's saved addresses, default first, then newest. */
export async function listAddresses(
  d1: D1Database,
  userId: string,
): Promise<CustomerAddress[]> {
  const db = drizzle(d1);
  return db
    .select()
    .from(customerAddresses)
    .where(eq(customerAddresses.userId, userId))
    .orderBy(
      desc(customerAddresses.isDefault),
      desc(customerAddresses.createdAt),
    )
    .all();
}

export async function createAddress(
  d1: D1Database,
  userId: string,
  input: CustomerAddressInput,
): Promise<
  { ok: true; address: CustomerAddress } | { ok: false; error: string }
> {
  const invalid = validateAddress(input);
  if (invalid) return { ok: false, error: invalid };
  const db = drizzle(d1);
  const existing = await listAddresses(d1, userId);
  if (existing.length >= MAX_ADDRESSES_PER_USER) {
    return { ok: false, error: "Address limit reached" };
  }
  const now = new Date().toISOString();
  const makeDefault = input.isDefault === true || existing.length === 0;
  if (makeDefault) {
    await db
      .update(customerAddresses)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(customerAddresses.userId, userId));
  }
  const row: CustomerAddress = {
    id: nanoid(),
    userId,
    name: input.name.trim(),
    line1: input.line1.trim(),
    line2: input.line2?.trim() || null,
    city: input.city.trim(),
    region: input.region?.trim() || null,
    postalCode: input.postalCode.trim(),
    countryCode: input.countryCode.trim().toUpperCase(),
    phone: input.phone?.trim() || null,
    isDefault: makeDefault,
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(customerAddresses).values(row);
  return { ok: true, address: row };
}

/**
 * Update an address. Scoped to the owner: the WHERE clause carries the
 * user id, so a forged address id belonging to someone else is a
 * silent no-op, never a cross-account write.
 */
export async function updateAddress(
  d1: D1Database,
  userId: string,
  addressId: string,
  input: CustomerAddressInput,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const invalid = validateAddress(input);
  if (invalid) return { ok: false, error: invalid };
  const db = drizzle(d1);
  const owned = await db
    .select({ id: customerAddresses.id })
    .from(customerAddresses)
    .where(
      and(
        eq(customerAddresses.id, addressId),
        eq(customerAddresses.userId, userId),
      ),
    )
    .limit(1)
    .get();
  if (!owned) return { ok: false, error: "Address not found" };
  const now = new Date().toISOString();
  if (input.isDefault === true) {
    await db
      .update(customerAddresses)
      .set({ isDefault: false, updatedAt: now })
      .where(eq(customerAddresses.userId, userId));
  }
  await db
    .update(customerAddresses)
    .set({
      name: input.name.trim(),
      line1: input.line1.trim(),
      line2: input.line2?.trim() || null,
      city: input.city.trim(),
      region: input.region?.trim() || null,
      postalCode: input.postalCode.trim(),
      countryCode: input.countryCode.trim().toUpperCase(),
      phone: input.phone?.trim() || null,
      ...(input.isDefault === true ? { isDefault: true } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(customerAddresses.id, addressId),
        eq(customerAddresses.userId, userId),
      ),
    );
  return { ok: true };
}

/** Delete an address — owner-scoped like updateAddress. */
export async function deleteAddress(
  d1: D1Database,
  userId: string,
  addressId: string,
): Promise<void> {
  const db = drizzle(d1);
  await db
    .delete(customerAddresses)
    .where(
      and(
        eq(customerAddresses.id, addressId),
        eq(customerAddresses.userId, userId),
      ),
    );
}

/**
 * Order history for the signed-in customer.
 *
 * Matches `shop_orders.email` — but ONLY when the session's email is
 * verified. The OTP sign-in always verifies; the gate exists so no
 * other path (an admin-created unverified row, a future social login
 * with an unconfirmed address) can read someone's orders by merely
 * CLAIMING their email.
 */
export async function listOrdersForCustomer(
  d1: D1Database,
  user: { email: string; emailVerified: boolean },
  opts: { limit?: number } = {},
): Promise<ShopOrder[]> {
  if (!user.emailVerified) return [];
  const db = drizzle(d1);
  return db
    .select()
    .from(shopOrders)
    .where(eq(shopOrders.email, user.email))
    .orderBy(desc(shopOrders.createdAt))
    .limit(Math.min(opts.limit ?? 50, 200))
    .all();
}

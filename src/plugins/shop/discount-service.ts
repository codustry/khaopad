/**
 * Discount service — apply codes at checkout + record redemptions on
 * payment success.
 *
 * Flow:
 *   1. Customer types a code in the checkout UI → POST
 *      /api/shop/cart/discount validates it and stashes on the cart
 *      (persists in cart.discountCode, matching the v3.4 attribution
 *      overload; prefix disambiguates).
 *   2. /api/shop/checkout/start reads the cart's discountCode,
 *      validates again (window, per-customer cap, subtotal minimum),
 *      computes the discount amount, and stores it on the order row
 *      via `discountSatang` (existing column from v3.2).
 *   3. Beam webhook markPaid handler records the redemption row
 *      once the order is paid — that's the moment the code should
 *      count against `maxRedemptions`.
 *
 * All validation errors return typed DiscountError so the UI can
 * surface a specific message ("code expired", "you've already used
 * this code", "minimum ฿500 order").
 */
import { drizzle } from "drizzle-orm/d1";
import { and, eq, count } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  shopDiscountCodes,
  shopDiscountRedemptions,
  type ShopDiscountCode,
} from "./schema-discount";

export type DiscountApplyOutcome =
  | {
      ok: true;
      discount: ShopDiscountCode;
      amountSatang: number;
      /** True when the code zeroed the shipping line (`kind='free_shipping'`). */
      freeShipping: boolean;
    }
  | {
      ok: false;
      reason:
        | "NOT_FOUND"
        | "INACTIVE"
        | "NOT_STARTED"
        | "EXPIRED"
        | "MAX_REDEMPTIONS_HIT"
        | "MAX_PER_CUSTOMER_HIT"
        | "SUBTOTAL_TOO_LOW";
      message: string;
    };

/**
 * Look up a discount code by user-typed string + validate it against
 * the cart context. Does NOT record a redemption — that happens only
 * on payment success in `recordRedemption()`.
 */
export async function validateDiscount(
  d1: D1Database,
  input: {
    code: string;
    subtotalSatang: number;
    shippingSatang: number;
    /** For per-customer cap: sign-in id if present, else email. */
    userId?: string | null;
    userEmail?: string | null;
  },
): Promise<DiscountApplyOutcome> {
  const canonicalCode = input.code.trim().toUpperCase();
  if (!canonicalCode) {
    return { ok: false, reason: "NOT_FOUND", message: "Enter a code" };
  }
  const db = drizzle(d1);
  const discount = await db
    .select()
    .from(shopDiscountCodes)
    .where(eq(shopDiscountCodes.code, canonicalCode))
    .limit(1)
    .get();
  if (!discount) {
    return { ok: false, reason: "NOT_FOUND", message: "Code not found" };
  }
  if (!discount.active) {
    return {
      ok: false,
      reason: "INACTIVE",
      message: "This code is no longer accepted",
    };
  }

  const nowIso = new Date().toISOString();
  if (discount.startsAt && discount.startsAt > nowIso) {
    return {
      ok: false,
      reason: "NOT_STARTED",
      message: "This code isn't active yet",
    };
  }
  if (discount.endsAt && discount.endsAt < nowIso) {
    return {
      ok: false,
      reason: "EXPIRED",
      message: "This code has expired",
    };
  }
  if (
    discount.minOrderSatang != null &&
    input.subtotalSatang < discount.minOrderSatang
  ) {
    return {
      ok: false,
      reason: "SUBTOTAL_TOO_LOW",
      message: `Minimum order is ฿${(discount.minOrderSatang / 100).toFixed(2)}`,
    };
  }

  if (discount.maxRedemptions != null) {
    const [row] = await db
      .select({ total: count() })
      .from(shopDiscountRedemptions)
      .where(eq(shopDiscountRedemptions.discountId, discount.id))
      .all();
    if ((row?.total ?? 0) >= discount.maxRedemptions) {
      return {
        ok: false,
        reason: "MAX_REDEMPTIONS_HIT",
        message: "This code has reached its redemption limit",
      };
    }
  }

  if (discount.maxPerCustomer != null) {
    // Match by user id when available (signed-in), else by email
    // (guest). This lets a guest and a signed-in visitor share the
    // same code without one blocking the other, which is what
    // Shopify Basic does too.
    // Email is lowercased on both sides — the redemption table stores
    // lowercase (see recordRedemption); comparing raw user input would
    // let `Foo@X.com` bypass a cap set against `foo@x.com`.
    const emailLower = input.userEmail?.toLowerCase() ?? null;
    const whereClause = input.userId
      ? and(
          eq(shopDiscountRedemptions.discountId, discount.id),
          eq(shopDiscountRedemptions.userId, input.userId),
        )
      : emailLower
        ? and(
            eq(shopDiscountRedemptions.discountId, discount.id),
            eq(shopDiscountRedemptions.userEmail, emailLower),
          )
        : null;
    if (whereClause) {
      const [row] = await db
        .select({ total: count() })
        .from(shopDiscountRedemptions)
        .where(whereClause)
        .all();
      if ((row?.total ?? 0) >= discount.maxPerCustomer) {
        return {
          ok: false,
          reason: "MAX_PER_CUSTOMER_HIT",
          message: "You've already used this code the maximum number of times",
        };
      }
    }
  }

  // Compute the amount to subtract.
  let amountSatang = 0;
  let freeShipping = false;
  switch (discount.kind) {
    case "fixed_satang":
      amountSatang = Math.min(discount.valueSatang ?? 0, input.subtotalSatang);
      break;
    case "percent":
      amountSatang = Math.round(
        (input.subtotalSatang * (discount.valuePercent ?? 0)) / 100,
      );
      // Cap: a percent code can't exceed the subtotal (avoid negative
      // totals when the merchant misconfigures a 200% code).
      amountSatang = Math.min(amountSatang, input.subtotalSatang);
      break;
    case "free_shipping":
      amountSatang = input.shippingSatang;
      freeShipping = true;
      break;
  }
  if (amountSatang < 0) amountSatang = 0;

  return { ok: true, discount, amountSatang, freeShipping };
}

/**
 * Record a redemption on payment success. Idempotent — composite PK
 * on (discountId, orderId) means a webhook retry inserts nothing new.
 * Callers do NOT need to wrap this in a try/catch for double-fire;
 * the `INSERT OR IGNORE` semantics handle it.
 */
export async function recordRedemption(
  d1: D1Database,
  input: {
    discountId: string;
    orderId: string;
    userId?: string | null;
    userEmail?: string | null;
    amountSatang: number;
  },
): Promise<void> {
  // D1 doesn't expose `.onConflictDoNothing()` uniformly across drizzle
  // versions on the sqlite dialect. Use raw SQL for the ignore-on-
  // conflict semantic — simplest correct path.
  await d1
    .prepare(
      `INSERT OR IGNORE INTO shop_discount_redemptions
         (discount_id, order_id, user_id, user_email, amount_satang, redeemed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
    .bind(
      input.discountId,
      input.orderId,
      input.userId ?? null,
      input.userEmail?.toLowerCase() ?? null,
      input.amountSatang,
      new Date().toISOString(),
    )
    .run();
}

/** Admin CRUD helpers. */
export async function listDiscounts(
  d1: D1Database,
): Promise<ShopDiscountCode[]> {
  const db = drizzle(d1);
  return db
    .select()
    .from(shopDiscountCodes)
    .orderBy(shopDiscountCodes.createdAt)
    .all();
}

export type CreateDiscountInput = {
  code: string;
  kind: "fixed_satang" | "percent" | "free_shipping";
  valueSatang?: number;
  valuePercent?: number;
  maxRedemptions?: number | null;
  maxPerCustomer?: number | null;
  minOrderSatang?: number | null;
  startsAt?: string | null;
  endsAt?: string | null;
  description?: string | null;
  createdBy?: string;
};

export async function createDiscount(
  d1: D1Database,
  input: CreateDiscountInput,
): Promise<string> {
  const canonicalCode = input.code.trim().toUpperCase();
  if (!/^[A-Z0-9_-]{2,32}$/.test(canonicalCode)) {
    throw new Error(
      `Discount code must be 2-32 chars, A-Z / 0-9 / _ / - only (got: ${input.code})`,
    );
  }
  const db = drizzle(d1);
  const id = nanoid();
  const now = new Date().toISOString();
  await db.insert(shopDiscountCodes).values({
    id,
    code: canonicalCode,
    kind: input.kind,
    valueSatang: input.valueSatang ?? null,
    valuePercent: input.valuePercent ?? null,
    maxRedemptions: input.maxRedemptions ?? null,
    maxPerCustomer: input.maxPerCustomer ?? null,
    minOrderSatang: input.minOrderSatang ?? null,
    startsAt: input.startsAt ?? null,
    endsAt: input.endsAt ?? null,
    active: true,
    description: input.description ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

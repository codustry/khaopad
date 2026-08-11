/**
 * ReviewService — all D1 access for @khaopad/plugin-reviews.
 *
 * Verified purchase (possession auth, #160 D2): a reviewer may attach
 * an order number + email. When that pair matches a PAID order (paidAt
 * set — payment actually captured, not merely created) whose items
 * include the reviewed product, the review is stored with verified=1
 * and the matched orderId. A wrong email, an unpaid order, or an order
 * that never contained the product all silently produce verified=0 —
 * the review is still accepted (it just doesn't get the badge), and
 * the response never discloses whether an order number exists. Same
 * disclosure budget philosophy as /api/shop/order/[n]/status.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, avg, count, desc, eq, gte, isNotNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { shopProductVariants } from "$plugins/shop/schema";
import { shopOrderItems, shopOrders } from "$plugins/shop/schema-cart";
import {
  productReviews,
  type ProductReview,
  type ReviewStatus,
} from "./schema";

export const REVIEW_MAX_TITLE = 150;
export const REVIEW_MAX_BODY = 4000;

export type ReviewSubmission = {
  productId: string;
  email: string;
  rating: number;
  title: string;
  body: string;
  locale?: string;
  /** Optional possession-auth pair for the verified badge. */
  orderNumber?: string | null;
  ipHash?: string | null;
};

export type ReviewAggregate = {
  /** Average of approved ratings, rounded to 1 decimal. Null when none. */
  average: number | null;
  count: number;
};

/**
 * Pure payload validation, exported separately so the API route and
 * tests share one source of truth. Mirrors the comments endpoint's
 * philosophy: cheap checks that stop obviously-bad input, not an RFC
 * parser.
 */
export function validateReviewPayload(input: {
  productId: string;
  email: string;
  rating: number;
  title: string;
  body: string;
}): { ok: true } | { ok: false; error: string } {
  if (!input.productId) return { ok: false, error: "Missing product id." };
  if (!input.email || !/.+@.+\..+/.test(input.email)) {
    return { ok: false, error: "A valid email is required." };
  }
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return { ok: false, error: "Rating must be a whole number from 1 to 5." };
  }
  if (!input.title.trim()) return { ok: false, error: "Title is required." };
  if (input.title.length > REVIEW_MAX_TITLE) {
    return { ok: false, error: `Title too long (max ${REVIEW_MAX_TITLE}).` };
  }
  if (!input.body.trim())
    return { ok: false, error: "Review body is required." };
  if (input.body.length > REVIEW_MAX_BODY) {
    return { ok: false, error: `Review too long (max ${REVIEW_MAX_BODY}).` };
  }
  return { ok: true };
}

export class ReviewService {
  private db: DrizzleD1Database;

  constructor(d1: D1Database) {
    this.db = drizzle(d1);
  }

  /**
   * Possession-auth check: does a PAID order with this (number, email)
   * pair contain this product? Order items reference variants, so the
   * product match goes through shop_product_variants.
   */
  async findVerifiedOrderId(
    orderNumber: string,
    email: string,
    productId: string,
  ): Promise<string | null> {
    const row = await this.db
      .select({ orderId: shopOrders.id })
      .from(shopOrders)
      .innerJoin(shopOrderItems, eq(shopOrderItems.orderId, shopOrders.id))
      .innerJoin(
        shopProductVariants,
        eq(shopProductVariants.id, shopOrderItems.variantId),
      )
      .where(
        and(
          eq(shopOrders.orderNumber, orderNumber),
          eq(shopOrders.email, email),
          // Paid means CAPTURED: paidAt is stamped when the payment
          // succeeds. financial_status can later move to refunded, but
          // the purchase still happened — the badge stays truthful.
          isNotNull(shopOrders.paidAt),
          eq(shopProductVariants.productId, productId),
        ),
      )
      .limit(1)
      .get();
    return row?.orderId ?? null;
  }

  /** Create a pending review, running verified-purchase matching. */
  async createReview(input: ReviewSubmission): Promise<ProductReview> {
    const valid = validateReviewPayload(input);
    if (!valid.ok) throw new Error(valid.error);

    let orderId: string | null = null;
    if (input.orderNumber && input.orderNumber.trim()) {
      orderId = await this.findVerifiedOrderId(
        input.orderNumber.trim(),
        input.email,
        input.productId,
      );
    }

    const review: ProductReview = {
      id: nanoid(),
      productId: input.productId,
      orderId,
      email: input.email,
      rating: input.rating,
      title: input.title.trim(),
      body: input.body.trim(),
      locale: input.locale === "th" ? "th" : "en",
      status: "pending",
      verified: orderId ? 1 : 0,
      ipHash: input.ipHash ?? null,
      createdAt: new Date().toISOString(),
    };
    await this.db.insert(productReviews).values(review);
    return review;
  }

  async getReview(id: string): Promise<ProductReview | null> {
    const row = await this.db
      .select()
      .from(productReviews)
      .where(eq(productReviews.id, id))
      .limit(1)
      .get();
    return row ?? null;
  }

  /** Approved reviews for the storefront, newest first. */
  async listApproved(productId: string, limit = 50): Promise<ProductReview[]> {
    return this.db
      .select()
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, productId),
          eq(productReviews.status, "approved"),
        ),
      )
      .orderBy(desc(productReviews.createdAt))
      .limit(Math.min(limit, 200))
      .all();
  }

  /** Average + count over APPROVED reviews only — feeds aggregateRating. */
  async getAggregate(productId: string): Promise<ReviewAggregate> {
    const row = await this.db
      .select({ average: avg(productReviews.rating), n: count() })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.productId, productId),
          eq(productReviews.status, "approved"),
        ),
      )
      .get();
    const n = row?.n ?? 0;
    if (!n) return { average: null, count: 0 };
    const raw = Number(row?.average);
    return {
      average: Number.isFinite(raw) ? Math.round(raw * 10) / 10 : null,
      count: n,
    };
  }

  /** Moderation queue listing. */
  async listByStatus(
    status: ReviewStatus,
    opts: { limit?: number; offset?: number } = {},
  ): Promise<ProductReview[]> {
    return this.db
      .select()
      .from(productReviews)
      .where(eq(productReviews.status, status))
      .orderBy(desc(productReviews.createdAt))
      .limit(Math.min(opts.limit ?? 50, 200))
      .offset(opts.offset ?? 0)
      .all();
  }

  async countByStatus(status: ReviewStatus): Promise<number> {
    const row = await this.db
      .select({ n: count() })
      .from(productReviews)
      .where(eq(productReviews.status, status))
      .get();
    return row?.n ?? 0;
  }

  /** Moderation transition. Returns the updated row or null if missing. */
  async setStatus(
    id: string,
    status: ReviewStatus,
  ): Promise<ProductReview | null> {
    await this.db
      .update(productReviews)
      .set({ status })
      .where(eq(productReviews.id, id));
    return this.getReview(id);
  }

  /**
   * Rate-limit window count, same scheme as forms/comments: ISO
   * timestamps compare lexicographically, so a plain >= works.
   */
  async countRecentByIp(
    ipHash: string,
    windowSeconds: number,
  ): Promise<number> {
    const cutoff = new Date(Date.now() - windowSeconds * 1000).toISOString();
    const row = await this.db
      .select({ n: count() })
      .from(productReviews)
      .where(
        and(
          eq(productReviews.ipHash, ipHash),
          gte(productReviews.createdAt, cutoff),
        ),
      )
      .get();
    return row?.n ?? 0;
  }
}

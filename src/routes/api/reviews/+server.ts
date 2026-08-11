/**
 * POST /api/reviews — public review submission (#160 D2).
 *
 * Owned by @khaopad/plugin-reviews (in-tree route placement per the
 * v3.0 plugin convention). Reuses the v2.0a spam floor exactly as
 * /api/comments does: honeypot field (`_hp`) + per-IP-hash rate limit
 * (3 per minute). Reviews land in `pending` and require editor
 * approval before rendering publicly.
 *
 * Verified purchase: optional orderNumber; when (orderNumber, email)
 * matches a paid order containing this product, verified=1. The
 * response never says whether the match happened — an attacker probing
 * order numbers learns nothing (same disclosure budget as /lookup).
 *
 * Returns:
 *   201 + { ok: true, status: "pending" } on success
 *   400 on validation failure (incl. honeypot — indistinguishable)
 *   404 when the product doesn't exist / isn't active
 *   429 on rate limit
 */
import { error, json } from "@sveltejs/kit";
import {
  HONEYPOT_FIELD,
  RATE_LIMIT_MAX_PER_WINDOW,
  RATE_LIMIT_WINDOW_SECONDS,
  hashIp,
} from "$lib/server/forms";
import { logAudit } from "$lib/server/audit";
import { ShopService } from "$plugins/shop/service";
import { ReviewService, validateReviewPayload } from "$plugins/reviews/service";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({
  request,
  platform,
  getClientAddress,
}) => {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  let payload: Record<string, FormDataEntryValue>;
  try {
    const fd = await request.formData();
    payload = Object.fromEntries(fd.entries());
  } catch {
    throw error(400, "Could not parse form body");
  }

  // Honeypot. Same 400 shape as real validation failures so bots
  // can't learn which check fired.
  const hp = payload[HONEYPOT_FIELD];
  if (typeof hp === "string" && hp.trim() !== "") {
    throw error(400, "Submission rejected.");
  }

  const productId = String(payload.product_id ?? "").trim();
  const email = String(payload.email ?? "").trim();
  const rating = Number(String(payload.rating ?? "").trim());
  const title = String(payload.title ?? "").trim();
  const body = String(payload.body ?? "").trim();
  const orderNumber = String(payload.order_number ?? "").trim();
  const locale = String(payload.locale ?? "en").trim();

  const valid = validateReviewPayload({
    productId,
    email,
    rating,
    title,
    body,
  });
  if (!valid.ok) throw error(400, valid.error);

  // The product must exist and be publicly visible — otherwise the
  // endpoint becomes an oracle for draft catalog entries.
  const shop = new ShopService(env.DB);
  const product = await shop.getProduct(productId);
  if (!product || product.status !== "active") {
    throw error(404, "Product not found");
  }

  // Per-IP-hash rate limit, same threshold as forms/comments.
  let ipHash: string | undefined;
  try {
    const ip = getClientAddress();
    if (ip) ipHash = await hashIp(ip);
  } catch {
    // getClientAddress may throw in dev preview — skip the check
  }
  const reviews = new ReviewService(env.DB);
  if (ipHash) {
    const recent = await reviews.countRecentByIp(
      ipHash,
      RATE_LIMIT_WINDOW_SECONDS,
    );
    if (recent >= RATE_LIMIT_MAX_PER_WINDOW) {
      throw error(429, "Too many reviews. Try again in a minute.");
    }
  }

  const review = await reviews.createReview({
    productId,
    email,
    rating,
    title,
    body,
    locale,
    orderNumber: orderNumber || null,
    ipHash: ipHash ?? null,
  });

  // Audit — public submission, no actor (userId nullable, SET NULL FK).
  await logAudit(env.DB, null, "review.create", review.id, {
    productId,
    rating,
    verified: review.verified === 1,
  });

  return json({ ok: true, status: "pending" }, { status: 201 });
};

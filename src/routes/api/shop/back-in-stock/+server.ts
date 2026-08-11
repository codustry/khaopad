/**
 * POST /api/shop/back-in-stock — restock waitlist capture (v3.17 D4).
 *
 * Body: { variantId, email, locale? }. Guest-accessible (waitlists are
 * exactly for people without accounts), same-origin guarded like every
 * state-changing shop endpoint. Dedupe lives in the module (UNIQUE
 * (variant_id, email)), so double-submits return ok with no new row.
 */
import { error, json } from "@sveltejs/kit";
import { subscribeBackInStock } from "$plugins/shop/back-in-stock";
import { requireSameOrigin } from "$lib/server/http/same-origin";
import type { RequestHandler } from "./$types";

export const POST: RequestHandler = async ({ request, platform, url }) => {
  const guard = requireSameOrigin(request, url);
  if (guard) return guard;
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");

  let body: { variantId?: string; email?: string; locale?: string };
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON" }, { status: 400 });
  }
  if (!body.variantId || typeof body.variantId !== "string") {
    return json(
      { ok: false, message: "variantId is required" },
      { status: 400 },
    );
  }
  if (!body.email || typeof body.email !== "string") {
    return json({ ok: false, message: "email is required" }, { status: 400 });
  }

  const result = await subscribeBackInStock(env.DB, {
    variantId: body.variantId,
    email: body.email,
    locale: body.locale,
  });
  if (!result.ok) {
    return json(
      {
        ok: false,
        message:
          result.error === "INVALID_EMAIL"
            ? "Please enter a valid email address"
            : "Unknown variant",
      },
      { status: 400 },
    );
  }
  return json({ ok: true, deduped: result.deduped });
};

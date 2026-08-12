/**
 * Tonbab commerce sync — inbound half (#160 Phase E-1).
 *
 * Tonbab (the POS) pushes its orders here; Khao Pad is the system of
 * record for the web shop and a mirror for POS sales. Pairing follows
 * the BEAM MODEL: Tonbab mints BOTH credentials during pairing, the
 * operator pastes them into /admin/settings/secrets, and inbound
 * traffic is HMAC-signed exactly like Beam's webhooks — NOT
 * API-key-authenticated.
 *
 * Semantics:
 *   - **upsert** — a POS sale. Created via OrderService with
 *     channel='tonbab_pos'; items matched by SKU (unknown SKU → that
 *     order errors, the batch continues); totals AS SUPPLIED (Tonbab
 *     is authoritative for its own sales — never recomputed). Arrives
 *     paid → on-hand inventory is deducted directly (POS stock was
 *     never reserved, so `reserved` is untouched). Replays of the
 *     same (source, externalId) are idempotent.
 *   - **transition** — fulfil / deliver / cancel / refund, applied
 *     through the EXISTING service transitions so domain events and
 *     the timeline fire normally (payloads carry `channel`, which is
 *     how Tonbab filters out echoes of its own orders). A transition
 *     against an already-terminal axis is `{skipped, reason}` — last
 *     write wins, never an error.
 *   - Every item lands in sync_log.
 *
 * Echo-loop guard: createExternalOrder deliberately does NOT emit
 * order.created (Tonbab already knows about its own sale).
 */
import { drizzle } from "drizzle-orm/d1";
import { inArray } from "drizzle-orm";
import { nanoid } from "nanoid";
import type { OrderService } from "$plugins/shop/order-service";
import { deductVariantOnHand } from "$plugins/shop/inventory";
import { shopProductVariants } from "$plugins/shop/schema";
import { ShopValidationError } from "$plugins/shop/service";
import { syncLog } from "./schema";

export const TONBAB_SOURCE = "tonbab";
export const TONBAB_SYNC_ACTOR = "tonbab-sync";

// ─── Signature verification ─────────────────────────────────
// Mirrors BeamPaymentProvider.verifyWebhook's idiom exactly:
// HMAC-SHA256 over the RAW body, key is the base64-DECODED secret
// (raw-string fallback when not valid base64), digest compared as
// base64 in constant time. Beam's helpers are module-private, so the
// idiom is reproduced here rather than imported.

async function hmacSha256Base64(
  base64Secret: string,
  body: string,
): Promise<string> {
  const enc = new TextEncoder();
  let decoded: Uint8Array;
  try {
    decoded = Uint8Array.from(atob(base64Secret), (c) => c.charCodeAt(0));
  } catch {
    decoded = enc.encode(base64Secret);
  }
  // Fresh ArrayBuffer copy — importKey's BufferSource wants the
  // narrower ArrayBuffer backing (same note as beam.ts).
  const keyBytes = new Uint8Array(decoded.length);
  keyBytes.set(decoded);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", keyMaterial, enc.encode(body));
  const digest = new Uint8Array(sig);
  return btoa(Array.from(digest, (b) => String.fromCharCode(b)).join(""));
}

/** Constant-time string comparison (timing-attack mitigation). */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export type TonbabVerifyResult =
  | { ok: true }
  | { ok: false; code: "MISSING_SIGNATURE" | "INVALID_SIGNATURE" };

/**
 * Verify `X-Tonbab-Signature` against the raw request body. Strips a
 * defensive `sha256=` prefix but never lowercases — base64 is
 * case-sensitive (see beam.ts).
 */
export async function verifyTonbabSignature(
  secret: string,
  rawBody: string,
  signature: string | null,
): Promise<TonbabVerifyResult> {
  if (!signature) return { ok: false, code: "MISSING_SIGNATURE" };
  const provided = signature.replace(/^sha256=/, "").trim();
  if (!provided) return { ok: false, code: "MISSING_SIGNATURE" };
  const expected = await hmacSha256Base64(secret, rawBody);
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, code: "INVALID_SIGNATURE" };
  }
  return { ok: true };
}

// ─── Payload types + shape validation ───────────────────────

export type TonbabUpsertOrder = {
  externalId: string;
  action: "upsert";
  /** POS receipts rarely carry an email; a stable placeholder is used. */
  email?: string | null;
  /** Defaults true — POS sales are paid at the counter. */
  paid?: boolean;
  /** ISO timestamp of the sale at the POS. */
  placedAt?: string | null;
  items: Array<{
    sku: string;
    quantity: number;
    priceSatang: number;
    title?: string | null;
  }>;
  totals: {
    subtotalSatang: number;
    shippingSatang?: number;
    taxSatang?: number;
    discountSatang?: number;
    totalSatang: number;
  };
};

export type TonbabTransitionOrder = {
  externalId?: string | null;
  /** Fallback join key for orders that originated in Khao Pad. */
  orderNumber?: string | null;
  action: "transition";
  to: "fulfilled" | "delivered" | "cancelled" | "refunded";
  refund?: {
    amountSatang: number;
    /** Monotonic per-order sequence — the refund idempotency key. */
    seq: number;
    reason?: string | null;
  } | null;
};

export type TonbabOrderPayload = TonbabUpsertOrder | TonbabTransitionOrder;

export type TonbabSyncBody = {
  source: "tonbab";
  orders: TonbabOrderPayload[];
};

export type TonbabParseResult =
  | { ok: true; body: TonbabSyncBody }
  | { ok: false; code: "INVALID_JSON" | "MALFORMED_PAYLOAD"; message: string };

/**
 * Shape-check the (already signature-verified) body. Per-ORDER field
 * problems are handled downstream as per-order errors; this only
 * rejects envelopes we cannot iterate at all.
 */
export function parseTonbabSyncBody(rawBody: string): TonbabParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, code: "INVALID_JSON", message: "Body is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      ok: false,
      code: "MALFORMED_PAYLOAD",
      message: "Body is not a JSON object",
    };
  }
  const body = parsed as Record<string, unknown>;
  if (body.source !== TONBAB_SOURCE) {
    return {
      ok: false,
      code: "MALFORMED_PAYLOAD",
      message: `source must be "${TONBAB_SOURCE}"`,
    };
  }
  if (!Array.isArray(body.orders)) {
    return {
      ok: false,
      code: "MALFORMED_PAYLOAD",
      message: "orders must be an array",
    };
  }
  return { ok: true, body: body as unknown as TonbabSyncBody };
}

// ─── Processing ─────────────────────────────────────────────

export type TonbabOrderResult = {
  externalId: string | null;
  action: string;
  ok: boolean;
  orderId?: string;
  orderNumber?: string;
  /** Upsert replay — the order already existed; nothing changed. */
  replayed?: boolean;
  /** Transition against an already-terminal axis — LWW, not an error. */
  skipped?: boolean;
  reason?: string;
  error?: string;
};

async function writeSyncLog(
  d1: D1Database,
  entry: {
    externalId: string | null;
    action: string;
    result: "created" | "replayed" | "applied" | "skipped" | "error";
    detail: string | null;
  },
): Promise<void> {
  try {
    await drizzle(d1).insert(syncLog).values({
      id: nanoid(),
      source: TONBAB_SOURCE,
      direction: "inbound",
      externalId: entry.externalId,
      action: entry.action,
      result: entry.result,
      detail: entry.detail,
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    // Audit write must never fail the sync item it describes.
    // eslint-disable-next-line no-console
    console.error(
      `[sync.tonbab] sync_log write failed:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/** POS receipts carry no customer email; keep a stable placeholder. */
const POS_FALLBACK_EMAIL = "pos@tonbab.sync";

async function processUpsert(
  d1: D1Database,
  orderSvc: OrderService,
  order: TonbabUpsertOrder,
): Promise<TonbabOrderResult> {
  const base = { externalId: order.externalId, action: "upsert" as string };
  if (
    !Array.isArray(order.items) ||
    order.items.length === 0 ||
    typeof order.totals !== "object" ||
    order.totals === null
  ) {
    return { ...base, ok: false, error: "upsert requires items and totals" };
  }

  // SKU → variant resolution. Unknown SKU fails THIS order (never
  // partial-imports a receipt — the totals wouldn't match its lines)
  // while the batch continues. Chunked at 90 SKUs per query: D1 caps
  // bound parameters at 100, and an unchunked inArray would
  // permanently fail any receipt with >100 distinct SKUs.
  const skus = order.items.map((i) => i.sku);
  const uniqueSkus = [...new Set(skus)];
  const SKU_CHUNK = 90;
  const variants: (typeof shopProductVariants.$inferSelect)[] = [];
  for (let i = 0; i < uniqueSkus.length; i += SKU_CHUNK) {
    variants.push(
      ...(await drizzle(d1)
        .select()
        .from(shopProductVariants)
        .where(
          inArray(shopProductVariants.sku, uniqueSkus.slice(i, i + SKU_CHUNK)),
        )
        .all()),
    );
  }
  const bySku = new Map(variants.map((v) => [v.sku, v]));
  const unknown = uniqueSkus.filter((s) => !bySku.has(s));
  if (unknown.length > 0) {
    return {
      ...base,
      ok: false,
      error: `Unknown SKU(s): ${unknown.join(", ")}`,
    };
  }
  // Money + quantity validation: everything lands in integer satang
  // columns and drives inventory math, so floats and negatives are
  // rejected per order (batch continues) rather than stored.
  for (const item of order.items) {
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      return {
        ...base,
        ok: false,
        error: `Invalid quantity for SKU ${item.sku}`,
      };
    }
    if (!Number.isInteger(item.priceSatang) || item.priceSatang < 0) {
      return {
        ...base,
        ok: false,
        error: `Invalid priceSatang for SKU ${item.sku} — must be a non-negative integer satang value`,
      };
    }
  }
  const moneyFields: Array<[string, unknown]> = [
    ["totals.subtotalSatang", order.totals.subtotalSatang],
    ["totals.totalSatang", order.totals.totalSatang],
    ["totals.shippingSatang", order.totals.shippingSatang ?? 0],
    ["totals.taxSatang", order.totals.taxSatang ?? 0],
    ["totals.discountSatang", order.totals.discountSatang ?? 0],
  ];
  for (const [field, value] of moneyFields) {
    if (!Number.isInteger(value) || (value as number) < 0) {
      return {
        ...base,
        ok: false,
        error: `Invalid ${field} — must be a non-negative integer satang value`,
      };
    }
  }

  const paid = order.paid !== false;
  const created = await orderSvc.createExternalOrder({
    externalSource: TONBAB_SOURCE,
    externalId: order.externalId,
    email: order.email || POS_FALLBACK_EMAIL,
    channel: "tonbab_pos",
    paid,
    placedAt: order.placedAt ?? null,
    items: order.items.map((item) => {
      const variant = bySku.get(item.sku)!;
      return {
        variantId: variant.id,
        quantity: item.quantity,
        titleSnapshot: item.title || variant.titleCached || "Default",
        skuSnapshot: item.sku,
        // Tonbab's price, not ours — POS may have counter discounts.
        priceSnapshotSatang: item.priceSatang,
      };
    }),
    subtotalSatang: order.totals.subtotalSatang,
    shippingSatang: order.totals.shippingSatang ?? 0,
    taxSatang: order.totals.taxSatang ?? 0,
    discountSatang: order.totals.discountSatang ?? 0,
    totalSatang: order.totals.totalSatang,
  });

  if (created.replayed && !created.repaired) {
    return {
      ...base,
      ok: true,
      orderId: created.orderId,
      orderNumber: created.orderNumber,
      replayed: true,
    };
  }

  // Paid POS sale: stock left the store at the counter. Deduct on-hand
  // DIRECTLY through the inventory module — POS stock was never
  // reserved, so commitVariantSale (which also decrements `reserved`)
  // would corrupt the availability books. Runs on first import AND on
  // a repairing replay (header row existed but items were lost mid-
  // create, so the deduction never happened); plain replays returned
  // above, so retries can't double-decrement.
  if (paid) {
    for (const item of order.items) {
      const variant = bySku.get(item.sku)!;
      try {
        await deductVariantOnHand(d1, variant.id, item.quantity);
      } catch (err) {
        // Order is already recorded and the physical sale happened —
        // never fail the import over inventory bookkeeping (same
        // contract as markPaid's commitVariantSale loop).
        // eslint-disable-next-line no-console
        console.error(
          `[sync.tonbab] on-hand deduction failed for SKU ${item.sku}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return {
    ...base,
    ok: true,
    orderId: created.orderId,
    orderNumber: created.orderNumber,
    replayed: created.replayed,
  };
}

async function processTransition(
  d1: D1Database,
  orderSvc: OrderService,
  order: TonbabTransitionOrder,
): Promise<TonbabOrderResult> {
  const action = `transition:${order.to}`;
  const base = { externalId: order.externalId ?? null, action };

  // Locate by external identity first (POS-originated orders), then by
  // order number (Khao Pad-originated orders Tonbab acts on).
  let target = order.externalId
    ? await orderSvc.getOrderByExternal(TONBAB_SOURCE, order.externalId)
    : null;
  if (!target && order.orderNumber) {
    target = await orderSvc.getOrderByNumber(order.orderNumber);
  }
  if (!target) {
    return { ...base, ok: false, error: "Order not found" };
  }
  const found = {
    ...base,
    orderId: target.id,
    orderNumber: target.orderNumber,
  };
  const skip = (reason: string): TonbabOrderResult => ({
    ...found,
    ok: true,
    skipped: true,
    reason,
  });

  // LWW semantics: a transition that the local axes have already moved
  // past (or into a terminal state) is acknowledged as skipped, never
  // errored — Tonbab keeps its view, Khao Pad keeps its own.
  switch (order.to) {
    case "fulfilled": {
      if (target.fulfillmentStatus !== "unfulfilled") {
        return skip(`already ${target.fulfillmentStatus}`);
      }
      const fulfillment = await orderSvc.markFulfilled(target.id, {
        actorEmail: TONBAB_SYNC_ACTOR,
      });
      if (!fulfillment) {
        return skip(`not fulfillable (financial: ${target.financialStatus})`);
      }
      return { ...found, ok: true };
    }
    case "delivered": {
      if (target.fulfillmentStatus === "delivered") {
        return skip("already delivered");
      }
      // POS flow often jumps straight to delivered (handed over at the
      // counter). Walk the existing machine: fulfil first if needed so
      // both timeline entries + events fire in order.
      if (target.fulfillmentStatus === "unfulfilled") {
        const fulfillment = await orderSvc.markFulfilled(target.id, {
          actorEmail: TONBAB_SYNC_ACTOR,
        });
        if (!fulfillment) {
          return skip(`not fulfillable (financial: ${target.financialStatus})`);
        }
      }
      await orderSvc.markDelivered(target.id, {
        actorEmail: TONBAB_SYNC_ACTOR,
      });
      return { ...found, ok: true };
    }
    case "cancelled": {
      if (
        target.financialStatus === "cancelled" ||
        target.financialStatus === "refunded"
      ) {
        return skip(`already ${target.financialStatus}`);
      }
      await orderSvc.markCancelled({ orderId: target.id });
      return { ...found, ok: true };
    }
    case "refunded": {
      const refund = order.refund;
      if (
        !refund ||
        !Number.isInteger(refund.amountSatang) ||
        refund.amountSatang <= 0 ||
        !Number.isInteger(refund.seq)
      ) {
        return {
          ...found,
          ok: false,
          error:
            "refund transition requires refund.amountSatang and refund.seq",
        };
      }
      const remaining = await orderSvc.refundableSatang(target.id);
      if (remaining <= 0) {
        return skip("already fully refunded");
      }
      try {
        const recorded = await orderSvc.recordRefund({
          orderId: target.id,
          amountSatang: refund.amountSatang,
          reason: refund.reason ?? "Tonbab POS refund",
          kind:
            refund.amountSatang >= remaining ? "refund_full" : "refund_partial",
          actorEmail: TONBAB_SYNC_ACTOR,
          // At-least-once delivery dedupes to one ledger row per seq.
          // Keyed on the RESOLVED internal order id — a join-key-
          // dependent key (externalId vs orderNumber) would let the
          // same refund record twice when Tonbab retries via the other
          // join key.
          idempotencyKey: `tonbab:${target.id}:${refund.seq}`,
        });
        return { ...found, ok: true, replayed: recorded.replayed };
      } catch (err) {
        if (err instanceof ShopValidationError) {
          // Over-balance or key-fingerprint mismatch: retrying can
          // never help — surface per order, batch continues.
          return { ...found, ok: false, error: err.message };
        }
        throw err;
      }
    }
    default:
      return {
        ...found,
        ok: false,
        error: `Unknown transition '${String(order.to)}'`,
      };
  }
}

/**
 * Process a verified batch. Per-order isolation: one bad order never
 * aborts the rest, and every item is recorded in sync_log.
 */
export async function processTonbabSync(
  d1: D1Database,
  orderSvc: OrderService,
  body: TonbabSyncBody,
): Promise<TonbabOrderResult[]> {
  const results: TonbabOrderResult[] = [];
  for (const order of body.orders) {
    let result: TonbabOrderResult;
    try {
      if (order.action === "upsert") {
        result = await processUpsert(d1, orderSvc, order);
      } else if (order.action === "transition") {
        result = await processTransition(d1, orderSvc, order);
      } else {
        result = {
          externalId:
            (order as { externalId?: string | null }).externalId ?? null,
          action: String((order as { action?: unknown }).action ?? "?"),
          ok: false,
          error: "action must be 'upsert' or 'transition'",
        };
      }
    } catch (err) {
      result = {
        externalId:
          (order as { externalId?: string | null }).externalId ?? null,
        action: String((order as { action?: unknown }).action ?? "?"),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
    results.push(result);
    await writeSyncLog(d1, {
      externalId: result.externalId,
      action: result.action,
      result: !result.ok
        ? "error"
        : result.skipped
          ? "skipped"
          : result.replayed
            ? "replayed"
            : result.action === "upsert"
              ? "created"
              : "applied",
      detail:
        result.error ??
        result.reason ??
        (result.orderNumber ? `→ ${result.orderNumber}` : null),
    });
  }
  return results;
}

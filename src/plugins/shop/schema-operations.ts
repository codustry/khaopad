/**
 * Operations tables — Phase C (v3.16) additions to the shop schema.
 *
 * Kept separate from schema-cart.ts (v3.2 cart/order core) the same way
 * schema-cart.ts is kept separate from schema.ts: this file is the
 * day-to-day operations layer (C1 fulfillment, C2 timeline, C10 returns)
 * that decorates orders without touching the money model.
 *
 * Design decisions:
 *
 * 1. **shop_fulfillments is a row-per-shipment table**, not columns on
 *    shop_orders — per-fulfillment IDs (#1001-F1 in the Shopify
 *    teardown) and partial fulfillment become possible later without
 *    another migration. Today the admin UI creates at most one row per
 *    order (the fulfillment axis is still order-level, #109).
 *
 * 2. **shop_order_events is append-only.** Rows are never updated or
 *    deleted — the timeline is an audit artifact. `kind` is free text
 *    in SQL (TS narrows it) so new event kinds never need a migration.
 *    `actor_email` is null for system-written events (webhook
 *    transitions) and set for admin actions/notes.
 *
 * 3. **shop_returns carries its own state machine**
 *    (requested → approved → received → refunded, rejected from
 *    requested/approved) and DRIVES the order's `return_status` axis
 *    (#109): requested/approved/received map 1:1, both terminals
 *    (refunded, rejected) map to `resolved`. The refund itself goes
 *    through the EXISTING adjustments-ledger path (#110) — this table
 *    never touches money.
 *
 * 4. **items_json** snapshots which line items the customer wants to
 *    return (`[{orderItemId, quantity}]`). Opaque JSON — per-line
 *    return math arrives with per-line fulfillment, not before.
 */
import { index, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { shopOrders } from "./schema-cart";

// ─── Fulfillments (C1) ──────────────────────────────────────

export const shopFulfillments = sqliteTable(
  "shop_fulfillments",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    // Carrier preset id from carriers.ts ('thailand_post' | 'kerry' |
    // 'flash' | 'jt' | 'dhl' | 'other') — stored as text so a removed
    // preset never orphans historical rows.
    carrier: text("carrier"),
    trackingNumber: text("tracking_number"),
    fulfilledAt: text("fulfilled_at").notNull(),
    // Set when the "shipped" email for this fulfillment went out —
    // guards against re-sending on a re-submitted form.
    notifiedAt: text("notified_at"),
  },
  (t) => ({
    orderIdx: index("shop_fulfillments_order_id_idx").on(t.orderId),
  }),
);

// ─── Order timeline (C2) ────────────────────────────────────

/** TS-side narrowing of `shop_order_events.kind`. */
export type OrderEventKind =
  | "created"
  | "paid"
  | "fulfilled"
  | "delivered"
  | "cancelled"
  | "refund"
  | "note"
  | "return_requested"
  | "return_approved"
  | "return_received"
  | "return_refunded"
  | "return_rejected"
  // #160 Phase E — order created/updated by an external sync push
  // (Tonbab POS). Free-text in SQL, so no migration needed.
  | "sync";

export const shopOrderEvents = sqliteTable(
  "shop_order_events",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    message: text("message"),
    // Null for system events (webhook-driven transitions); the acting
    // admin's email for admin actions and notes.
    actorEmail: text("actor_email"),
    createdAt: text("created_at").notNull(),
  },
  (t) => ({
    orderIdx: index("shop_order_events_order_created_idx").on(
      t.orderId,
      t.createdAt,
    ),
  }),
);

// ─── Returns (C10) ──────────────────────────────────────────

export type ReturnState =
  | "requested"
  | "approved"
  | "received"
  | "refunded"
  | "rejected";

export const shopReturns = sqliteTable(
  "shop_returns",
  {
    id: text("id").primaryKey(),
    orderId: text("order_id")
      .notNull()
      .references(() => shopOrders.id, { onDelete: "cascade" }),
    state: text("state", {
      enum: ["requested", "approved", "received", "refunded", "rejected"],
    }).notNull(),
    reasonText: text("reason_text"),
    // `[{orderItemId, quantity}]` — which lines the customer wants to
    // send back. Opaque snapshot; refund math stays in the ledger.
    itemsJson: text("items_json"),
    createdAt: text("created_at").notNull(),
    // Set when the return reaches a terminal state (refunded/rejected).
    resolvedAt: text("resolved_at"),
  },
  (t) => ({
    orderIdx: index("shop_returns_order_id_idx").on(t.orderId),
  }),
);

// ─── Type exports ───────────────────────────────────────────

export type ShopFulfillment = typeof shopFulfillments.$inferSelect;
export type ShopOrderEvent = typeof shopOrderEvents.$inferSelect;
export type ShopReturn = typeof shopReturns.$inferSelect;

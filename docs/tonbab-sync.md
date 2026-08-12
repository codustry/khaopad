# Tonbab commerce sync — Khao Pad half (#160 Phase E-1)

Khao Pad ↔ Tonbab POS order sync. This document covers the **inbound**
half that ships in E-1: Tonbab pushes its POS orders and order
transitions into Khao Pad. Outbound (Khao Pad → Tonbab catalog/stock
calls, authenticated with `TONBAB_API_KEY`) is a later phase; the key is
stored now so pairing is a one-time ceremony.

## Pairing (Beam model)

Tonbab mints **all** credentials; Khao Pad only stores them. Inbound
traffic is HMAC-signed like Beam's payment webhooks — **not**
API-key-authenticated.

On the Tonbab side:

1. Settings → Khao Pad sync → start pairing.
2. Tonbab mints two credentials:
   - an **API key** — for future Khao Pad → Tonbab calls (store-only
     today),
   - a **webhook secret** — signs every Tonbab → Khao Pad push.
3. Enter the Khao Pad inbound endpoint URL (shown on
   `/admin/settings/connections`):
   `https://<your-domain>/api/sync/tonbab`

On the Khao Pad side:

1. As a **super admin**, open `/admin/settings/secrets` and paste both
   values into the **Tonbab sync** group (`TONBAB_API_KEY`,
   `TONBAB_WEBHOOK_SECRET`). Stored encrypted; effective on the next
   request — no redeploy.
2. `/admin/settings/connections` (admin+) shows pairing status, the
   endpoint URL, and the latest sync activity.

Until `TONBAB_WEBHOOK_SECRET` is stored, the endpoint answers **503
`SYNC_NOT_CONFIGURED`**.

## Signature computation

Header: `X-Tonbab-Signature`.

- HMAC-SHA256 over the **raw request body bytes**, exactly as sent.
- Key material: the webhook secret, **base64-decoded** to bytes. (If the
  secret is not valid base64 the raw string bytes are used — same
  fallback as the Beam integration.)
- Digest encoded as **base64** (case-sensitive; never lowercase it).
  A `sha256=` prefix is tolerated but not required.
- Khao Pad compares in constant time.

Example (Node):

```js
import { createHmac } from "node:crypto";

const secret = process.env.TONBAB_WEBHOOK_SECRET; // as minted, base64
const body = JSON.stringify(payload); // send THESE exact bytes

const signature = createHmac("sha256", Buffer.from(secret, "base64"))
  .update(body)
  .digest("base64");

await fetch("https://shop.example.com/api/sync/tonbab", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-tonbab-signature": signature,
  },
  body,
});
```

## Endpoint contract

`POST /api/sync/tonbab`

### Request

```json
{
  "source": "tonbab",
  "orders": [
    {
      "externalId": "TB-2026-00042",
      "action": "upsert",
      "email": null,
      "paid": true,
      "placedAt": "2026-08-12T09:30:00.000Z",
      "items": [
        {
          "sku": "TSHIRT-RED-M",
          "quantity": 2,
          "priceSatang": 45000,
          "title": "Red tee / M"
        }
      ],
      "totals": {
        "subtotalSatang": 90000,
        "shippingSatang": 0,
        "taxSatang": 6300,
        "discountSatang": 0,
        "totalSatang": 96300
      }
    },
    {
      "externalId": "TB-2026-00040",
      "action": "transition",
      "to": "refunded",
      "refund": {
        "amountSatang": 96300,
        "seq": 1,
        "reason": "Returned at counter"
      }
    },
    {
      "orderNumber": "KHP-2026-00107",
      "action": "transition",
      "to": "fulfilled"
    }
  ]
}
```

- `action: "upsert"` — a POS sale. `items[].sku` must match Khao Pad
  variant SKUs; `paid` defaults to `true`; `email` defaults to a stable
  placeholder (`pos@tonbab.sync`). All money fields (`items[].priceSatang`
  and every `totals.*Satang`) must be **non-negative integers** — floats
  or negatives fail that order.
- `action: "transition"` — `to` is one of `fulfilled`, `delivered`,
  `cancelled`, `refunded`. The order is located by
  `(source, externalId)` first, then by `orderNumber` (for orders that
  originated in Khao Pad). `refunded` requires
  `refund.amountSatang` (positive integer satang) and `refund.seq` (a
  monotonic per-order sequence). Refund deduplication is keyed on the
  **resolved internal order + seq** (internally
  `tonbab:<khaopadOrderId>:<seq>`), so the same `seq` for the same
  order dedupes to one refund even when one delivery joins via
  `externalId` and a retry joins via `orderNumber`.

### Response

`200` unless authentication or envelope shape failed:

```json
{
  "ok": true,
  "results": [
    {
      "externalId": "TB-2026-00042",
      "action": "upsert",
      "ok": true,
      "orderId": "…",
      "orderNumber": "KHP-2026-00110",
      "replayed": false
    },
    {
      "externalId": "TB-2026-00040",
      "action": "transition:refunded",
      "ok": true,
      "orderId": "…",
      "orderNumber": "KHP-2026-00098",
      "replayed": false
    },
    {
      "externalId": null,
      "action": "transition:fulfilled",
      "ok": true,
      "orderId": "…",
      "orderNumber": "KHP-2026-00107"
    },
    {
      "externalId": "TB-2026-00043",
      "action": "upsert",
      "ok": false,
      "error": "Unknown SKU(s): NOPE-123"
    },
    {
      "externalId": "TB-2026-00039",
      "action": "transition:cancelled",
      "ok": true,
      "skipped": true,
      "reason": "already refunded"
    }
  ]
}
```

Failure responses:

| Status | Code                                      | Meaning                                |
| ------ | ----------------------------------------- | -------------------------------------- |
| 503    | `NO_PLATFORM`                             | D1 binding unavailable                 |
| 503    | `SYNC_NOT_CONFIGURED`                     | `TONBAB_WEBHOOK_SECRET` not stored yet |
| 401    | `MISSING_SIGNATURE` / `INVALID_SIGNATURE` | HMAC absent or wrong                   |
| 400    | `INVALID_JSON` / `MALFORMED_PAYLOAD`      | Signed but unusable envelope           |

Per-order failures (unknown SKU, order not found, invalid refund) are
`results` entries with `ok: false` — never a non-200. Tonbab should
retry only the failed items.

## Semantics

- **Totals as supplied.** Tonbab is authoritative for its own sales;
  Khao Pad never recomputes, re-taxes, or re-allocates POS totals.
  Per-line discount allocation is stored as 0 for POS orders.
- **Inventory.** A paid POS sale deducts `on_hand` directly (once —
  on first import, or on the item-repairing replay described below).
  `reserved` is untouched — POS stock never passed through the web
  shop's reserve→commit flow. Cancelling a paid POS order (via sync or
  the admin UI) restores those units to `on_hand`; it never releases
  web-customer reservations.
- **Idempotency.** Upsert replays of the same `(source, externalId)`
  return the existing order (`replayed: true`) — enforced by a partial
  UNIQUE index (migration 0030). Refunds dedupe on
  `tonbab:<khaopadOrderId>:<seq>` through the adjustments ledger — the
  key uses the resolved internal order id, so it is independent of
  which join key (externalId or orderNumber) located the order.
- **Upsert is create-only.** A replay with a CHANGED payload — an
  order that flipped `paid: false` → `paid: true`, edited lines,
  different totals — is acknowledged `replayed: true` and **ignored**:
  the first successful import is what Khao Pad keeps. Tonbab must send
  corrections as `transition` actions (cancel/refund), or as a fresh
  order under a new `externalId`. There is deliberately **no
  unpaid→paid sync transition** today — import POS orders once they
  are paid. (One exception to "ignored": if an earlier import crashed
  after the order header but before its line items were stored, the
  replay repairs the missing items and completes the inventory
  deduction — using the replayed payload's items.)
- **LWW (last write wins).** A transition against an axis that has
  already moved past it — cancel on a refunded order, fulfil on a
  delivered one — is acknowledged as `{skipped: true, reason}`, never
  an error. Each side keeps its own view; nothing loops.
- **Echo-loop guard.** Orders created by this endpoint do **not** emit
  `order.created` outbound — Tonbab already knows about its own sale.
  All other lifecycle events (`order.paid`, `order.fulfilled`,
  `order.cancelled`, `order.refunded`, …) fire normally and carry
  `channel` in the payload; Tonbab must ignore events where
  `channel === "tonbab_pos"` unless it wants its own echoes.
- **Audit.** Every processed item is appended to `sync_log`
  (source/direction/action/result/detail), surfaced on
  `/admin/settings/connections`. Timeline entries on synced orders use
  `kind: "sync"` and actor `tonbab-sync`.

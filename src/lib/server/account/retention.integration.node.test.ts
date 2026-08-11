/**
 * v3.17 (#160 Phase D) — customer retention integration tests.
 *
 * Same better-sqlite3 + migration-replay harness as the shop plugin's
 * operations tests: every test runs against the REAL migrations,
 * 0027_customer_retention included — so "the migration applies" is
 * proven by every beforeEach, and asserted explicitly below.
 *
 * Covers: customer_addresses CRUD (owner-scoping, default handling,
 * validation), order history matched by email ONLY when verified, and
 * back-in-stock subscribe (dedupe, email validation) + notify
 * (notify-once, cap, re-subscribe after notification).
 */
import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAddress,
  deleteAddress,
  listAddresses,
  listOrdersForCustomer,
  updateAddress,
} from "./index";
import {
  BIS_NOTIFY_CAP,
  notifyBackInStock,
  subscribeBackInStock,
} from "$plugins/shop/back-in-stock";

const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

function applyMigrations(db: Database.Database) {
  for (const file of migrationFiles()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) db.exec(stmt);
    }
  }
}

/** Minimal D1Database shim over better-sqlite3 (same as operations tests). */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    const numbered = [...sql.matchAll(/\?(\d+)/g)].map((m) => Number(m[1]));
    const bound =
      numbered.length > 0 ? numbered.map((n) => params[n - 1]) : params;
    const stmt = db.prepare(sql.replace(/\?\d+/g, "?"));
    if (/^\s*(select|pragma)/i.test(sql) || /returning/i.test(sql)) {
      const results = stmt.all(...bound);
      return { results, success: true, meta: {} };
    }
    const info = stmt.run(...bound);
    return { results: [], success: true, meta: { changes: info.changes } };
  };
  const makeStmt = (sql: string, params: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...p: unknown[]) => makeStmt(sql, p),
      all: async () => run(sql, params),
      run: async () => run(sql, params),
      first: async (col?: string) => {
        const r = run(sql, params).results as Record<string, unknown>[];
        const row = r[0] ?? null;
        return col && row ? row[col] : row;
      },
      raw: async () =>
        (run(sql, params).results as Record<string, unknown>[]).map((r) =>
          Object.values(r),
        ),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: D1PreparedStatement[]) =>
      Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

const NOW = "2026-08-12T10:00:00.000Z";

function seedUser(db: Database.Database, id: string, email: string) {
  db.prepare(
    `INSERT INTO users (id, name, email, email_verified, role, created_at, updated_at)
     VALUES (?, 'Test Customer', ?, 1, 'customer', ?, ?)`,
  ).run(id, email, NOW, NOW);
}

function seedVariant(db: Database.Database, variantId: string) {
  db.prepare(
    `INSERT OR IGNORE INTO shop_products (id, slug, status, created_at, updated_at)
     VALUES ('prod-1', 'classic-tee', 'active', ?, ?)`,
  ).run(NOW, NOW);
  db.prepare(
    `INSERT OR IGNORE INTO shop_product_localizations (product_id, locale, title)
     VALUES ('prod-1', 'en', 'Classic Tee'), ('prod-1', 'th', 'เสื้อยืดคลาสสิก')`,
  ).run();
  db.prepare(
    `INSERT INTO shop_product_variants (id, product_id, status, title_cached, price_satang, position)
     VALUES (?, 'prod-1', 'active', 'Default', 19900, 1)`,
  ).run(variantId);
}

function seedOrder(
  db: Database.Database,
  id: string,
  email: string,
  createdAt = NOW,
) {
  db.prepare(
    `INSERT INTO shop_orders
       (id, order_number, email, status, financial_status, fulfillment_status,
        provider_name, subtotal_satang, total_satang, created_at, updated_at)
     VALUES (?, ?, ?, 'paid', 'paid', 'unfulfilled', 'beam', 25000, 25000, ?, ?)`,
  ).run(id, `KHP-2026-${id}`, email, createdAt, createdAt);
}

let sqlite: Database.Database;
let d1: D1Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  applyMigrations(sqlite);
  d1 = d1Shim(sqlite);
});

afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("migration 0027 applies", () => {
  it("creates both tables with the dedupe index", () => {
    const tables = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN
         ('customer_addresses', 'back_in_stock_subscriptions')`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name).sort()).toEqual([
      "back_in_stock_subscriptions",
      "customer_addresses",
    ]);
    const idx = sqlite
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index'
         AND name = 'back_in_stock_variant_email_idx'`,
      )
      .get();
    expect(idx).toBeTruthy();
  });

  it("is registered in the journal as idx 27", () => {
    const journal = JSON.parse(
      readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    const entry = journal.entries.find((e) => e.idx === 27);
    expect(entry?.tag).toBe("0027_customer_retention");
  });
});

describe("customer addresses CRUD", () => {
  const ADDR = {
    name: "Somsri T.",
    line1: "99/1 Sukhumvit Rd",
    line2: null,
    city: "Bangkok",
    region: null,
    postalCode: "10110",
    countryCode: "th",
    phone: null,
  };

  beforeEach(() => {
    seedUser(sqlite, "user-1", "somsri@example.com");
    seedUser(sqlite, "user-2", "other@example.com");
  });

  it("creates, lists, updates, deletes", async () => {
    const created = await createAddress(d1, "user-1", ADDR);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // Country code normalized to upper case; first address auto-default.
    expect(created.address.countryCode).toBe("TH");
    expect(created.address.isDefault).toBe(true);

    let list = await listAddresses(d1, "user-1");
    expect(list).toHaveLength(1);

    const updated = await updateAddress(d1, "user-1", created.address.id, {
      ...ADDR,
      city: "Chiang Mai",
      postalCode: "50000",
    });
    expect(updated.ok).toBe(true);
    list = await listAddresses(d1, "user-1");
    expect(list[0].city).toBe("Chiang Mai");

    await deleteAddress(d1, "user-1", created.address.id);
    expect(await listAddresses(d1, "user-1")).toHaveLength(0);
  });

  it("making a second address default clears the first", async () => {
    const a = await createAddress(d1, "user-1", ADDR);
    const b = await createAddress(d1, "user-1", {
      ...ADDR,
      line1: "2nd address",
      isDefault: true,
    });
    expect(a.ok && b.ok).toBe(true);
    const list = await listAddresses(d1, "user-1");
    expect(list).toHaveLength(2);
    // Default-first ordering, and exactly one default.
    expect(list[0].line1).toBe("2nd address");
    expect(list.filter((x) => x.isDefault)).toHaveLength(1);
  });

  it("update and delete are owner-scoped", async () => {
    const created = await createAddress(d1, "user-1", ADDR);
    if (!created.ok) throw new Error("seed failed");
    const foreign = await updateAddress(d1, "user-2", created.address.id, {
      ...ADDR,
      city: "Hacked",
    });
    expect(foreign.ok).toBe(false);
    await deleteAddress(d1, "user-2", created.address.id);
    // Still there — the other user's delete was a no-op.
    expect(await listAddresses(d1, "user-1")).toHaveLength(1);
  });

  it("rejects incomplete or malformed input", async () => {
    const noName = await createAddress(d1, "user-1", { ...ADDR, name: " " });
    expect(noName.ok).toBe(false);
    const badCountry = await createAddress(d1, "user-1", {
      ...ADDR,
      countryCode: "Thailand",
    });
    expect(badCountry.ok).toBe(false);
  });
});

describe("order history by verified email", () => {
  it("matches orders by email for a verified user only", async () => {
    seedOrder(sqlite, "ord-1", "somsri@example.com");
    seedOrder(sqlite, "ord-2", "somsri@example.com", "2026-08-01T00:00:00Z");
    seedOrder(sqlite, "ord-3", "other@example.com");

    const verified = await listOrdersForCustomer(d1, {
      email: "somsri@example.com",
      emailVerified: true,
    });
    expect(verified.map((o) => o.id)).toEqual(["ord-1", "ord-2"]); // newest first, no cross-email rows

    // The gate: an unverified session sees NOTHING, even for its own
    // email — claiming an address must never be enough to read orders.
    const unverified = await listOrdersForCustomer(d1, {
      email: "somsri@example.com",
      emailVerified: false,
    });
    expect(unverified).toEqual([]);
  });
});

describe("back-in-stock", () => {
  beforeEach(() => {
    seedVariant(sqlite, "var-1");
  });

  function rows() {
    return sqlite
      .prepare(
        `SELECT email, locale, notified_at FROM back_in_stock_subscriptions
         WHERE variant_id = 'var-1' ORDER BY created_at`,
      )
      .all() as Array<{
      email: string;
      locale: string;
      notified_at: string | null;
    }>;
  }

  it("capture requires a valid email and a real variant", async () => {
    expect(
      await subscribeBackInStock(d1, { variantId: "var-1", email: "nope" }),
    ).toEqual({ ok: false, error: "INVALID_EMAIL" });
    expect(
      await subscribeBackInStock(d1, {
        variantId: "ghost",
        email: "a@b.co",
      }),
    ).toEqual({ ok: false, error: "UNKNOWN_VARIANT" });
    expect(rows()).toHaveLength(0);
  });

  it("dedupes on (variant, email) — case-insensitive", async () => {
    const first = await subscribeBackInStock(d1, {
      variantId: "var-1",
      email: "Wait@Example.com",
      locale: "th",
    });
    expect(first).toEqual({ ok: true, deduped: false });
    const second = await subscribeBackInStock(d1, {
      variantId: "var-1",
      email: "wait@example.com",
    });
    expect(second).toEqual({ ok: true, deduped: true });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].locale).toBe("th"); // original row untouched
  });

  it("notifies once, marks notifiedAt, and allows re-subscribe after", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    await subscribeBackInStock(d1, { variantId: "var-1", email: "a@b.co" });
    await subscribeBackInStock(d1, {
      variantId: "var-1",
      email: "c@d.co",
      locale: "th",
    });

    const env = {
      RESEND_API_KEY: "re_test",
      RESEND_FROM: "shop@example.com",
      PUBLIC_SITE_URL: "https://shop.example.com",
    };
    const sent = await notifyBackInStock(env, d1, "var-1");
    expect(sent).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rows().every((r) => r.notified_at !== null)).toBe(true);

    // Thai subscriber gets the Thai product URL + localized title.
    const bodies = fetchMock.mock.calls.map(
      (c) =>
        JSON.parse((c[1] as RequestInit).body as string) as {
          to: string[];
          html: string;
        },
    );
    const thai = bodies.find((b) => b.to[0] === "c@d.co");
    expect(thai?.html).toContain("/th/products/classic-tee");
    expect(thai?.html).toContain("เสื้อยืดคลาสสิก");

    // Notify-once: a second restock sends nothing new.
    fetchMock.mockClear();
    expect(await notifyBackInStock(env, d1, "var-1")).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();

    // …but the customer may re-join the waitlist for the next restock.
    const resub = await subscribeBackInStock(d1, {
      variantId: "var-1",
      email: "a@b.co",
    });
    expect(resub).toEqual({ ok: true, deduped: false });
    expect(
      rows().filter((r) => r.email === "a@b.co" && r.notified_at === null),
    ).toHaveLength(1);
  });

  it("caps a single restock batch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    for (let i = 0; i < BIS_NOTIFY_CAP + 5; i++) {
      await subscribeBackInStock(d1, {
        variantId: "var-1",
        email: `bulk${i}@example.com`,
      });
    }
    const sent = await notifyBackInStock(
      { RESEND_API_KEY: "re_test", RESEND_FROM: "shop@example.com" },
      d1,
      "var-1",
    );
    expect(sent).toBe(BIS_NOTIFY_CAP);
    expect(fetchMock).toHaveBeenCalledTimes(BIS_NOTIFY_CAP);
    // The overflow stays pending for the next restock.
    expect(rows().filter((r) => r.notified_at === null)).toHaveLength(5);
  });

  it("leaves rows pending when Resend is unconfigured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await subscribeBackInStock(d1, { variantId: "var-1", email: "a@b.co" });
    const sent = await notifyBackInStock({}, d1, "var-1");
    expect(sent).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    // Still pending — the first restock after Resend is configured
    // will pick this subscriber up rather than silently burning them.
    expect(rows()[0].notified_at).toBeNull();
  });
});

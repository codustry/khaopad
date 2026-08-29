/**
 * Pins the durable 24h reset-email throttle.
 *
 * These exercise the module against a fake D1 that implements the ONE
 * semantic the limiter depends on: `INSERT ... ON CONFLICT DO UPDATE ...
 * WHERE <cond>` reports `changes: 0` when the WHERE suppresses the update.
 * That is what makes the claim atomic instead of a read-then-write race,
 * so the fake models it rather than modelling a generic key-value store.
 *
 * What this CANNOT prove: that real D1 honours the same statement. The
 * SQL is exercised for real by the migration + `pnpm run db:migrate`; the
 * production proof is a second reset request inside 24h producing no
 * second email, which needs a deployed Worker with a Resend key.
 */
import { describe, it, expect, vi } from "vitest";
import {
  claimResetSlot,
  claimResetIpSlot,
  emailThrottleKey,
  ipThrottleKey,
  RESET_EMAIL_WINDOW_MS,
  RESET_IP_MAX_SENDS,
  type ThrottleD1,
} from "./reset-throttle";

/**
 * Fake D1 implementing the upsert semantics the real statement relies on.
 * Rows are keyed exactly as production keys them.
 */
function fakeDb(): ThrottleD1 & { rows: Map<string, [number, number]> } {
  const rows = new Map<string, [number, number]>();
  return {
    rows,
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const [key, now, cutoff, maxSends] = args as [
                string,
                number,
                number,
                number | undefined,
              ];
              const existing = rows.get(key);
              if (!existing) {
                rows.set(key, [now, 1]);
                return { meta: { changes: 1 } };
              }
              const [lastSentAt, sendCount] = existing;
              const expired = lastSentAt <= cutoff;
              // Per-IP statement carries a 4th bind and an OR clause.
              const isIpRule = sql.includes("send_count < ?4");
              const allowed =
                expired || (isIpRule && sendCount < (maxSends ?? 0));
              if (!allowed) return { meta: { changes: 0 } };
              rows.set(key, [
                now,
                isIpRule ? (expired ? 1 : sendCount + 1) : sendCount + 1,
              ]);
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

describe("emailThrottleKey", () => {
  it("hashes the address rather than storing it", async () => {
    const key = await emailThrottleKey("admin@example.com");
    expect(key).toMatch(/^email:[0-9a-f]{64}$/);
    // The table must never become a readable list of who forgot a password.
    expect(key).not.toContain("admin@example.com");
  });

  it("treats case and surrounding space as the same address", async () => {
    // Otherwise `Admin@x.com` buys a second daily budget over `admin@x.com`.
    expect(await emailThrottleKey("  Admin@Example.COM ")).toBe(
      await emailThrottleKey("admin@example.com"),
    );
  });

  it("gives different addresses different keys", async () => {
    expect(await emailThrottleKey("a@example.com")).not.toBe(
      await emailThrottleKey("b@example.com"),
    );
  });

  it("hashes IPs too", async () => {
    expect(await ipThrottleKey("203.0.113.7")).toMatch(/^ip:[0-9a-f]{64}$/);
  });
});

describe("claimResetSlot — one email per account per 24h", () => {
  it("allows the first send and BLOCKS the second inside the window", async () => {
    const db = fakeDb();
    const key = await emailThrottleKey("admin@example.com");
    const t0 = 1_800_000_000_000;

    expect(await claimResetSlot(db, key, t0)).toBe(true);
    // The explicit requirement: a second send is refused.
    expect(await claimResetSlot(db, key, t0 + 1000)).toBe(false);
    // Still refused most of a day later.
    expect(await claimResetSlot(db, key, t0 + RESET_EMAIL_WINDOW_MS - 1)).toBe(
      false,
    );
  });

  it("allows a send again once the 24h window has passed", async () => {
    const db = fakeDb();
    const key = await emailThrottleKey("admin@example.com");
    const t0 = 1_800_000_000_000;

    expect(await claimResetSlot(db, key, t0)).toBe(true);
    expect(await claimResetSlot(db, key, t0 + RESET_EMAIL_WINDOW_MS + 1)).toBe(
      true,
    );
  });

  it("budgets each account separately", async () => {
    const db = fakeDb();
    const t0 = 1_800_000_000_000;
    expect(
      await claimResetSlot(db, await emailThrottleKey("a@x.com"), t0),
    ).toBe(true);
    // One person's reset must not consume another's daily budget.
    expect(
      await claimResetSlot(db, await emailThrottleKey("b@x.com"), t0),
    ).toBe(true);
  });

  it("only one of two concurrent claims wins", async () => {
    // The TOCTOU case the atomic upsert exists to prevent.
    const db = fakeDb();
    const key = await emailThrottleKey("admin@example.com");
    const results = await Promise.all([
      claimResetSlot(db, key, 1_800_000_000_000),
      claimResetSlot(db, key, 1_800_000_000_000),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("fails OPEN when the database throws", async () => {
    // A locked-out admin with a flaky D1 must still be able to recover;
    // a duplicate email beats a permanently unrecoverable account.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken: ThrottleD1 = {
      prepare() {
        return {
          bind() {
            return {
              async run(): Promise<{ meta?: { changes?: number } }> {
                throw new Error("D1 unavailable");
              },
            };
          },
        };
      },
    };
    expect(await claimResetSlot(broken, "email:whatever")).toBe(true);
    warn.mockRestore();
  });
});

describe("claimResetIpSlot — per-IP defence in depth", () => {
  it("allows a bounded number of sends then blocks", async () => {
    const db = fakeDb();
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < RESET_IP_MAX_SENDS; i++) {
      expect(await claimResetIpSlot(db, "203.0.113.7", t0 + i)).toBe(true);
    }
    // Cap reached — walking a list of addresses now costs the attacker.
    expect(
      await claimResetIpSlot(db, "203.0.113.7", t0 + RESET_IP_MAX_SENDS),
    ).toBe(false);
  });

  it("does not let one IP exhaust another's budget", async () => {
    const db = fakeDb();
    const t0 = 1_800_000_000_000;
    for (let i = 0; i < RESET_IP_MAX_SENDS; i++) {
      await claimResetIpSlot(db, "203.0.113.7", t0 + i);
    }
    expect(await claimResetIpSlot(db, "198.51.100.4", t0)).toBe(true);
  });

  it("is far more permissive than the per-account limit", () => {
    // A shared office NAT must not be locked out by one colleague's reset.
    expect(RESET_IP_MAX_SENDS).toBeGreaterThan(1);
  });
});

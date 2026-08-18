import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  AUTH_RATE_LIMIT_KEY_PREFIX,
  AUTH_RATE_LIMIT_TTL_SECONDS,
  createKvRateLimitStorage,
  resetKvRateLimitWarnings,
  type RateLimitKV,
} from "./kv-rate-limit";
import { createAuth, resetMissingKvWarning } from "./index";

/**
 * KV-backed auth rate-limit storage (#182).
 *
 * Better Auth's default limiter storage is a per-isolate in-memory Map —
 * near-inert on Workers. These tests pin the KV adapter's contract
 * (prefixing, TTL, fail-open behavior) and that createAuth actually wires
 * it when the binding exists / degrades silently when it doesn't.
 */

/**
 * Minimal fake KV honoring `expirationTtl`, driven by a controllable
 * clock so TTL expiry is testable without real waiting.
 */
function fakeKv() {
  let now = 1_000_000;
  const store = new Map<string, { value: string; expiresAt: number }>();
  const kv: RateLimitKV = {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (now >= entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      const ttl = options?.expirationTtl ?? Infinity;
      if (ttl < 60) {
        // Real Cloudflare KV rejects sub-60s TTLs with a 400. Mirror that
        // so an adapter regression fails here instead of in production.
        throw new Error(
          `Invalid expiration_ttl of ${ttl}. Must be at least 60.`,
        );
      }
      store.set(key, { value, expiresAt: now + ttl * 1000 });
    },
  };
  return {
    kv,
    store,
    advance(seconds: number) {
      now += seconds * 1000;
    },
  };
}

beforeEach(() => {
  resetKvRateLimitWarnings();
  resetMissingKvWarning();
  vi.restoreAllMocks();
});

describe("createKvRateLimitStorage", () => {
  it("round-trips a rate-limit entry", async () => {
    const { kv } = fakeKv();
    const storage = createKvRateLimitStorage(kv);
    const entry = { key: "1.2.3.4|/sign-in/email", count: 2, lastRequest: 123 };

    await storage.set(entry.key, entry);
    expect(await storage.get(entry.key)).toEqual(entry);
  });

  it("returns null for a missing key", async () => {
    const storage = createKvRateLimitStorage(fakeKv().kv);
    expect(await storage.get("nope|/sign-in/email")).toBeNull();
  });

  it("namespaces every entry under the auth:rl: prefix", async () => {
    const { kv, store } = fakeKv();
    const storage = createKvRateLimitStorage(kv);
    const key = "1.2.3.4|/change-password";

    await storage.set(key, { key, count: 1, lastRequest: 1 });

    expect([...store.keys()]).toEqual([`auth:rl:${key}`]);
    // Pin the prefix itself: CONTENT_CACHE is shared with the query cache
    // ("q:", "gen:") and the careers feed cache — a prefix change risks
    // key-space collisions.
    expect(AUTH_RATE_LIMIT_KEY_PREFIX).toBe("auth:rl:");
  });

  it("does not read entries written outside its prefix (no CONTENT_CACHE bleed)", async () => {
    const { kv, store } = fakeKv();
    const storage = createKvRateLimitStorage(kv);
    // An unprefixed entry with the same logical key, as another CONTENT_CACHE
    // tenant might write.
    store.set("1.2.3.4|/sign-in/email", {
      value: JSON.stringify({ key: "x", count: 99, lastRequest: 1 }),
      expiresAt: Infinity,
    });

    expect(await storage.get("1.2.3.4|/sign-in/email")).toBeNull();
  });

  it("writes with a TTL >= KV's 60s minimum and >= the longest 60s window", async () => {
    expect(AUTH_RATE_LIMIT_TTL_SECONDS).toBeGreaterThanOrEqual(60);
    // The longest built-in Better Auth window (OTP send / password reset)
    // is 60s; the TTL must outlive it or counters vanish mid-window.
    expect(AUTH_RATE_LIMIT_TTL_SECONDS).toBeGreaterThanOrEqual(60);

    // And the adapter actually passes it (the fake throws on ttl < 60).
    const { kv, store } = fakeKv();
    await createKvRateLimitStorage(kv).set("k", {
      key: "k",
      count: 1,
      lastRequest: 1,
    });
    expect(store.size).toBe(1);
  });

  it("entries expire after the TTL", async () => {
    const { kv, advance } = fakeKv();
    const storage = createKvRateLimitStorage(kv);
    await storage.set("k", { key: "k", count: 3, lastRequest: 1 });

    advance(AUTH_RATE_LIMIT_TTL_SECONDS - 1);
    expect(await storage.get("k")).not.toBeNull();

    advance(2);
    expect(await storage.get("k")).toBeNull();
  });

  it("fails open when KV.get throws — and logs once, not per request", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createKvRateLimitStorage({
      get: async () => {
        throw new Error("KV outage");
      },
      put: async () => {},
    });

    expect(await storage.get("k")).toBeNull();
    expect(await storage.get("k")).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("swallows KV.put failures — a lost counter must not 500 auth", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const storage = createKvRateLimitStorage({
      get: async () => null,
      put: async () => {
        throw new Error("KV outage");
      },
    });

    await expect(
      storage.set("k", { key: "k", count: 1, lastRequest: 1 }),
    ).resolves.toBeUndefined();
    await storage.set("k", { key: "k", count: 2, lastRequest: 2 });
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("treats a corrupt stored entry as absent", async () => {
    const { kv, store } = fakeKv();
    const storage = createKvRateLimitStorage(kv);
    store.set("auth:rl:bad-json", { value: "{not json", expiresAt: Infinity });
    store.set("auth:rl:bad-shape", {
      value: JSON.stringify({ hello: "world" }),
      expiresAt: Infinity,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await storage.get("bad-json")).toBeNull();
    expect(await storage.get("bad-shape")).toBeNull();
    expect(errorSpy).toHaveBeenCalledTimes(1); // JSON.parse throw logs; shape check doesn't
  });
});

describe("createAuth rate-limit wiring", () => {
  /**
   * betterAuth() does not query the database at construction, so a bare
   * stub D1 suffices — only handler/api calls would touch it.
   */
  const stubD1 = {
    prepare: () => {
      throw new Error("test stub — no queries expected at construction");
    },
  } as unknown as D1Database;

  const baseEnv = {
    BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret",
    BETTER_AUTH_URL: "http://localhost:5173",
  };

  it("passes KV-backed customStorage when the binding exists", () => {
    const { kv } = fakeKv();
    const auth = createAuth(stubD1, {
      ...baseEnv,
      CONTENT_CACHE: kv as unknown as KVNamespace,
    });

    expect(auth.options.rateLimit?.enabled).toBe(true);
    expect(auth.options.rateLimit?.customStorage).toBeDefined();
    expect(typeof auth.options.rateLimit?.customStorage?.get).toBe("function");
    expect(typeof auth.options.rateLimit?.customStorage?.set).toBe("function");
  });

  it("the wired storage actually talks to the provided KV namespace", async () => {
    const { kv, store } = fakeKv();
    const auth = createAuth(stubD1, {
      ...baseEnv,
      CONTENT_CACHE: kv as unknown as KVNamespace,
    });

    const key = "9.9.9.9|/sign-in/email";
    await auth.options.rateLimit!.customStorage!.set(key, {
      key,
      count: 1,
      lastRequest: 42,
    });
    expect(store.has(`auth:rl:${key}`)).toBe(true);
  });

  it("falls back to the in-memory default (no customStorage) when the binding is absent — without crashing", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const auth = createAuth(stubD1, baseEnv);

    expect(auth.options.rateLimit?.enabled).toBe(true);
    expect(auth.options.rateLimit?.customStorage).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain("CONTENT_CACHE");
  });

  it("logs the missing-binding warning once per isolate, not per request", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    createAuth(stubD1, baseEnv);
    createAuth(stubD1, baseEnv);
    createAuth(stubD1, baseEnv);

    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

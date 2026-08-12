import { describe, expect, it, vi } from "vitest";
import { normalizeFeed, CAREERS_CACHE_VERSION } from "./feed";
import {
  CAREERS_TTL_SECONDS,
  careersCacheKey,
  fetchFeedBody,
  loadCareersFeed,
  resolveFeedUrl,
} from "./service";

/**
 * #161 — the headline property under test is that `loadCareersFeed`
 * NEVER rejects and never returns nothing when it has something. Each
 * failure mode below (HTTP error, network throw, timeout, garbage
 * body, dead KV) must resolve to the best data available:
 *
 *   live → cached → stale → unavailable(empty)
 *
 * Nothing here touches the real network: `fetchImpl` and `now` are
 * injected, and the KV binding is a hand-rolled in-memory fake.
 */

const FEED_URL = "https://app.tonbab.com/api/careers/codustry/jobs";

const VALID_JOB = {
  id: "job-1",
  number: "JOB-0001",
  title: "Full-stack Engineer",
  department: "Engineering",
  employment_type: "full_time",
  location: "Bangkok / Remote",
  category: {
    slug: "engineering",
    name_en: "Engineering",
    name_th: "วิศวกรรม",
  },
  salary: { min: 60000, max: 90000, currency: "THB" },
  published_at: "2026-08-01T04:00:00Z",
  apply_url: "https://app.tonbab.com/careers/codustry/job-1",
};

const BODY = JSON.stringify({ company: "Codustry", jobs: [VALID_JOB] });

/** Minimal in-memory KV double — only the three methods the service uses. */
function fakeKv(seed: Record<string, string> = {}) {
  const store = new Map(Object.entries(seed));
  return {
    store,
    kv: {
      get: vi.fn(async (key: string, type?: string) => {
        const raw = store.get(key);
        if (raw === undefined) return null;
        return type === "json" ? JSON.parse(raw) : raw;
      }),
      put: vi.fn(async (key: string, value: string) => {
        store.set(key, value);
      }),
      delete: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    } as unknown as KVNamespace,
  };
}

function okResponse(body: string) {
  return new Response(body, { status: 200 });
}

function cachedEntry(fetchedAt: number, jobs: unknown[] = [VALID_JOB]) {
  return JSON.stringify({
    v: CAREERS_CACHE_VERSION,
    feed: normalizeFeed({ company: "Codustry", jobs }),
    fetchedAt,
  });
}

// ─── resolveFeedUrl ─────────────────────────────────────────

describe("resolveFeedUrl — unset config disables the feature", () => {
  it("returns the URL when configured", () => {
    expect(resolveFeedUrl({ CAREERS_FEED_URL: FEED_URL })).toBe(`${FEED_URL}`);
  });

  it.each([
    ["undefined env", undefined],
    ["absent var", {}],
    ["empty string", { CAREERS_FEED_URL: "" }],
    ["whitespace", { CAREERS_FEED_URL: "   " }],
    ["not a URL", { CAREERS_FEED_URL: "app.tonbab.com/jobs" }],
    ["javascript: scheme", { CAREERS_FEED_URL: "javascript:alert(1)" }],
    ["file: scheme", { CAREERS_FEED_URL: "file:///etc/passwd" }],
  ])("returns null for %s", (_label, env) => {
    expect(resolveFeedUrl(env as { CAREERS_FEED_URL?: string })).toBeNull();
  });
});

// ─── fetchFeedBody ──────────────────────────────────────────

describe("fetchFeedBody — never throws", () => {
  it("returns the body on 200", async () => {
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    await expect(
      fetchFeedBody(FEED_URL, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(BODY);
  });

  it.each([404, 429, 500, 502, 503])(
    "returns null on HTTP %i",
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response("nope", { status }));
      await expect(
        fetchFeedBody(FEED_URL, {
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).resolves.toBeNull();
    },
  );

  it("returns null when fetch throws (DNS/TLS/network)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(
      fetchFeedBody(FEED_URL, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
  });

  it("aborts a hanging upstream and returns null", async () => {
    // A request that never settles on its own — only the abort signal
    // can end it. Without the timeout this test would hang forever,
    // which is precisely the production failure it guards against.
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const started = Date.now();
    await expect(
      fetchFeedBody(FEED_URL, {
        timeoutMs: 25,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("passes an abort signal so the timeout can actually fire", async () => {
    // Typed with the args it actually receives, so the assertion below
    // reads them without casting away the mock's inferred signature.
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      okResponse(BODY),
    );
    await fetchFeedBody(FEED_URL, {
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(FEED_URL);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

// ─── loadCareersFeed: the degradation ladder ────────────────

describe("loadCareersFeed — live path", () => {
  it("fetches, parses and reports live", async () => {
    const { kv } = fakeKv();
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 10_000,
    });
    expect(result.status).toBe("live");
    expect(result.feed.jobs).toHaveLength(1);
    expect(result.feed.company).toBe("Codustry");
    expect(result.fetchedAt).toBe(10_000);
  });

  it("writes the parsed feed to KV under a URL-derived key", async () => {
    const { kv, store } = fakeKv();
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 10_000,
    });
    const key = careersCacheKey(FEED_URL);
    expect(store.has(key)).toBe(true);
    expect(JSON.parse(store.get(key)!)).toMatchObject({
      v: CAREERS_CACHE_VERSION,
      fetchedAt: 10_000,
    });
  });

  it("works with no KV binding at all", async () => {
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv: null,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.status).toBe("live");
    expect(result.feed.jobs).toHaveLength(1);
  });

  it("caches an empty-but-valid feed as a real answer", async () => {
    const { kv, store } = fakeKv();
    const fetchImpl = vi.fn(async () =>
      okResponse(JSON.stringify({ company: "Codustry", jobs: [] })),
    );
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 10_000,
    });
    expect(result.status).toBe("live");
    expect(result.feed.jobs).toEqual([]);
    expect(store.has(careersCacheKey(FEED_URL))).toBe(true);
  });

  it("keys different feed URLs separately", () => {
    expect(careersCacheKey(FEED_URL)).not.toBe(
      careersCacheKey("https://app.tonbab.com/api/careers/other/jobs"),
    );
  });
});

describe("loadCareersFeed — fresh cache short-circuits the network", () => {
  it("serves a cached entry inside the TTL without fetching", async () => {
    const { kv } = fakeKv({
      [careersCacheKey(FEED_URL)]: cachedEntry(10_000),
    });
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      // 100s later, well inside the 300s TTL.
      now: () => 110_000,
    });
    expect(result.status).toBe("cached");
    expect(result.feed.jobs).toHaveLength(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refetches once the TTL has elapsed", async () => {
    const { kv } = fakeKv({
      [careersCacheKey(FEED_URL)]: cachedEntry(0),
    });
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => CAREERS_TTL_SECONDS * 1000 + 1,
    });
    expect(result.status).toBe("live");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("loadCareersFeed — stale-on-error is the outage guarantee", () => {
  it.each([
    ["HTTP 500", vi.fn(async () => new Response("boom", { status: 500 }))],
    [
      "network throw",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    ],
    ["malformed JSON body", vi.fn(async () => okResponse('{"jobs":['))],
    [
      "an HTML error page with a 200",
      vi.fn(async () => okResponse("<html>502</html>")),
    ],
  ])(
    "serves stale cached jobs when upstream fails with %s",
    async (_l, fetchImpl) => {
      const { kv } = fakeKv({
        [careersCacheKey(FEED_URL)]: cachedEntry(0),
      });
      const result = await loadCareersFeed({
        feedUrl: FEED_URL,
        kv,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => CAREERS_TTL_SECONDS * 1000 + 1,
      });
      expect(result.status).toBe("stale");
      expect(result.feed.jobs).toHaveLength(1);
      expect(result.fetchedAt).toBe(0);
    },
  );

  it("does not overwrite good cached jobs with a garbled response", async () => {
    const key = careersCacheKey(FEED_URL);
    const { kv, store } = fakeKv({ [key]: cachedEntry(0) });
    const before = store.get(key);
    await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: vi.fn(async () =>
        okResponse("not json"),
      ) as unknown as typeof fetch,
      now: () => CAREERS_TTL_SECONDS * 1000 + 1,
    });
    expect(store.get(key)).toBe(before);
  });

  it("serves stale rather than empty when upstream times out", async () => {
    const { kv } = fakeKv({ [careersCacheKey(FEED_URL)]: cachedEntry(0) });
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      timeoutMs: 25,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => CAREERS_TTL_SECONDS * 1000 + 1,
    });
    expect(result.status).toBe("stale");
    expect(result.feed.jobs).toHaveLength(1);
  });
});

describe("loadCareersFeed — total failure degrades to the empty state", () => {
  it("returns an empty feed, not an error, with no cache and a dead upstream", async () => {
    const { kv } = fakeKv();
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: vi.fn(async () => {
        throw new Error("upstream down");
      }) as unknown as typeof fetch,
    });
    expect(result.status).toBe("unavailable");
    expect(result.feed.jobs).toEqual([]);
    expect(result.feed.company).toBeNull();
    expect(result.fetchedAt).toBeNull();
  });

  it("survives a KV binding that throws on both read and write", async () => {
    // A KV outage must not become a page outage.
    const brokenKv = {
      get: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
      put: vi.fn(async () => {
        throw new Error("KV unavailable");
      }),
    } as unknown as KVNamespace;
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv: brokenKv,
      fetchImpl: vi.fn(async () => okResponse(BODY)) as unknown as typeof fetch,
    });
    expect(result.status).toBe("live");
    expect(result.feed.jobs).toHaveLength(1);
  });

  it("treats a cache entry written by an older format version as a miss", async () => {
    const { kv } = fakeKv({
      [careersCacheKey(FEED_URL)]: JSON.stringify({
        v: 999,
        feed: { jobs: [VALID_JOB] },
        fetchedAt: 10_000,
      }),
    });
    const fetchImpl = vi.fn(async () => okResponse(BODY));
    const result = await loadCareersFeed({
      feedUrl: FEED_URL,
      kv,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => 10_100,
    });
    expect(result.status).toBe("live");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never rejects, for any combination of failures", async () => {
    const brokenKv = {
      get: vi.fn(async () => {
        throw new Error("KV down");
      }),
      put: vi.fn(async () => {
        throw new Error("KV down");
      }),
    } as unknown as KVNamespace;
    await expect(
      loadCareersFeed({
        feedUrl: FEED_URL,
        kv: brokenKv,
        fetchImpl: vi.fn(async () => {
          throw new Error("everything is on fire");
        }) as unknown as typeof fetch,
      }),
    ).resolves.toMatchObject({ status: "unavailable" });
  });
});

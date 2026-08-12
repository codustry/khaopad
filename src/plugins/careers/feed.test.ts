import { describe, expect, it } from "vitest";
import {
  categoryLabel,
  collectCategories,
  filterByCategory,
  humanizeEmploymentType,
  normalizeFeed,
  normalizeJob,
  parseCachedFeed,
  parseFeedBody,
  safeIsoDate,
  safeUrl,
  sortJobs,
  toSchemaEmploymentType,
  type CareersJob,
} from "./feed";

/**
 * #161 — the careers feed comes from a third-party ATS this repo does
 * not control. The contract these tests pin down is **degrade, never
 * throw**: no input, however malformed or hostile, may produce an
 * exception, and no unsafe value may survive into the render payload.
 *
 * The canonical payload below is copied from the feed contract in
 * issue #161 (`GET /api/careers/{slug}/jobs`).
 */

const VALID_JOB = {
  id: "6f2c1111-2222-3333-4444-555566667777",
  number: "JOB-0001",
  title: "Full-stack Engineer (SvelteKit)",
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
  apply_url: "https://app.tonbab.com/careers/codustry/6f2c1111",
};

const VALID_FEED = { company: "Codustry", jobs: [VALID_JOB] };

// ─── Happy path ─────────────────────────────────────────────

describe("normalizeFeed — the documented payload", () => {
  it("maps every field of a well-formed job", () => {
    const feed = normalizeFeed(VALID_FEED);
    expect(feed.company).toBe("Codustry");
    expect(feed.jobs).toHaveLength(1);

    const job = feed.jobs[0]!;
    expect(job).toEqual({
      id: "6f2c1111-2222-3333-4444-555566667777",
      number: "JOB-0001",
      title: "Full-stack Engineer (SvelteKit)",
      department: "Engineering",
      employmentType: "full_time",
      employmentTypeSchema: "FULL_TIME",
      location: "Bangkok / Remote",
      category: {
        slug: "engineering",
        nameEn: "Engineering",
        nameTh: "วิศวกรรม",
      },
      salary: { min: 60000, max: 90000, currency: "THB" },
      publishedAt: "2026-08-01T04:00:00.000Z",
      applyUrl: "https://app.tonbab.com/careers/codustry/6f2c1111",
    });
  });

  it("accepts a bare array of jobs (envelope omitted)", () => {
    const feed = normalizeFeed([VALID_JOB]);
    expect(feed.company).toBeNull();
    expect(feed.jobs).toHaveLength(1);
  });
});

// ─── Missing / optional fields ──────────────────────────────

describe("normalizeJob — missing optional fields degrade to null", () => {
  it("keeps a job that has only the three required fields", () => {
    const job = normalizeJob({
      id: "abc",
      title: "Designer",
      apply_url: "https://example.com/apply",
    });
    expect(job).not.toBeNull();
    expect(job!.department).toBeNull();
    expect(job!.location).toBeNull();
    expect(job!.category).toBeNull();
    expect(job!.salary).toBeNull();
    expect(job!.publishedAt).toBeNull();
    expect(job!.number).toBeNull();
    expect(job!.employmentType).toBeNull();
    expect(job!.employmentTypeSchema).toBeNull();
  });

  it("treats explicit nulls exactly like absent fields", () => {
    const job = normalizeJob({
      id: "abc",
      title: "Designer",
      apply_url: "https://example.com/apply",
      department: null,
      location: null,
      category: null,
      salary: null,
      published_at: null,
      number: null,
    });
    expect(job!.department).toBeNull();
    expect(job!.salary).toBeNull();
    expect(job!.publishedAt).toBeNull();
  });

  it("treats empty and whitespace-only strings as absent", () => {
    const job = normalizeJob({
      id: "abc",
      title: "Designer",
      apply_url: "https://example.com/apply",
      department: "   ",
      location: "",
    });
    expect(job!.department).toBeNull();
    expect(job!.location).toBeNull();
  });

  it("trims surrounding whitespace on kept strings", () => {
    const job = normalizeJob({
      id: "abc",
      title: "  Designer  ",
      apply_url: "https://example.com/apply",
    });
    expect(job!.title).toBe("Designer");
  });
});

describe("normalizeJob — drops entries that cannot be rendered", () => {
  it.each([
    ["missing id", { title: "X", apply_url: "https://e.com/a" }],
    ["missing title", { id: "1", apply_url: "https://e.com/a" }],
    ["missing apply_url", { id: "1", title: "X" }],
    ["null entry", null],
    ["string entry", "not a job"],
    ["array entry", []],
    ["number entry", 42],
  ])("returns null for %s", (_label, input) => {
    expect(normalizeJob(input)).toBeNull();
  });

  it("rejects a non-string title rather than coercing it", () => {
    expect(
      normalizeJob({ id: "1", title: 42, apply_url: "https://e.com/a" }),
    ).toBeNull();
  });

  it("accepts a numeric id, which ATS exports commonly emit", () => {
    const job = normalizeJob({
      id: 1234,
      title: "X",
      apply_url: "https://e.com/a",
    });
    expect(job!.id).toBe("1234");
  });
});

// ─── Security: URL scheme gate ──────────────────────────────

describe("safeUrl — the XSS gate on every apply link", () => {
  it.each([
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "  javascript:alert(1)  ",
    "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
    "/relative/path",
    "not a url at all",
    "",
  ])("rejects %j", (input) => {
    expect(safeUrl(input)).toBeNull();
  });

  it.each(["http://example.com/a", "https://example.com/a"])(
    "accepts %j",
    (input) => {
      expect(safeUrl(input)).not.toBeNull();
    },
  );

  it("drops a whole job whose apply_url is a javascript: URL", () => {
    const feed = normalizeFeed({
      jobs: [{ ...VALID_JOB, apply_url: "javascript:alert(document.cookie)" }],
    });
    expect(feed.jobs).toHaveLength(0);
  });

  it("never lets a script-bearing title through as anything but text", () => {
    // The parser preserves the text verbatim — escaping is the
    // renderer's job (Svelte text interpolation / jsonld escaping).
    // What matters here is that it does not throw or truncate.
    const feed = normalizeFeed({
      jobs: [{ ...VALID_JOB, title: "</script><img src=x onerror=alert(1)>" }],
    });
    expect(feed.jobs[0]!.title).toBe("</script><img src=x onerror=alert(1)>");
  });
});

// ─── Dates ──────────────────────────────────────────────────

describe("safeIsoDate", () => {
  it("normalizes a valid timestamp to ISO", () => {
    expect(safeIsoDate("2026-08-01T04:00:00Z")).toBe(
      "2026-08-01T04:00:00.000Z",
    );
  });

  it.each(["not-a-date", "", "   ", null, undefined, 12345, {}])(
    "returns null for %j",
    (input) => {
      expect(safeIsoDate(input)).toBeNull();
    },
  );
});

// ─── Salary ─────────────────────────────────────────────────

describe("salary normalization — only real, opted-in figures survive", () => {
  it("is null when the posting withheld salary", () => {
    const job = normalizeJob({ ...VALID_JOB, salary: null });
    expect(job!.salary).toBeNull();
  });

  it("is null when the object carries neither bound", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      salary: { min: null, max: null, currency: "THB" },
    });
    expect(job!.salary).toBeNull();
  });

  it("keeps a one-sided range", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      salary: { min: 50000, max: null, currency: "THB" },
    });
    expect(job!.salary).toEqual({ min: 50000, max: null, currency: "THB" });
  });

  it("swaps a reversed range rather than dropping it", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      salary: { min: 90000, max: 60000, currency: "THB" },
    });
    expect(job!.salary).toEqual({ min: 60000, max: 90000, currency: "THB" });
  });

  it("defaults the currency to THB and upper-cases it", () => {
    expect(
      normalizeJob({ ...VALID_JOB, salary: { min: 1, max: 2 } })!.salary!
        .currency,
    ).toBe("THB");
    expect(
      normalizeJob({
        ...VALID_JOB,
        salary: { min: 1, max: 2, currency: "usd" },
      })!.salary!.currency,
    ).toBe("USD");
  });

  it("rejects NaN, Infinity and negative figures", () => {
    for (const bad of [NaN, Infinity, -Infinity, -5000]) {
      const job = normalizeJob({
        ...VALID_JOB,
        salary: { min: bad, max: null, currency: "THB" },
      });
      expect(job!.salary).toBeNull();
    }
  });

  it("parses numeric strings, which some feeds emit", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      salary: { min: "60000", max: "90000", currency: "THB" },
    });
    expect(job!.salary).toEqual({ min: 60000, max: 90000, currency: "THB" });
  });

  it("ignores a salary that is not an object", () => {
    expect(normalizeJob({ ...VALID_JOB, salary: "lots" })!.salary).toBeNull();
  });
});

// ─── Categories ─────────────────────────────────────────────

describe("category normalization", () => {
  it("falls back across locales when one name is missing", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      category: { slug: "eng", name_en: "Engineering" },
    });
    expect(job!.category).toEqual({
      slug: "eng",
      nameEn: "Engineering",
      nameTh: "Engineering",
    });
  });

  it("derives a slug when the feed omits one", () => {
    const job = normalizeJob({
      ...VALID_JOB,
      category: { name_en: "People Ops" },
    });
    expect(job!.category!.slug).toBe("people-ops");
  });

  it("drops a category with no usable label", () => {
    expect(
      normalizeJob({ ...VALID_JOB, category: { slug: "x" } })!.category,
    ).toBeNull();
    expect(normalizeJob({ ...VALID_JOB, category: 7 })!.category).toBeNull();
  });

  it("picks the locale-appropriate label", () => {
    const cat = { slug: "eng", nameEn: "Engineering", nameTh: "วิศวกรรม" };
    expect(categoryLabel(cat, "en")).toBe("Engineering");
    expect(categoryLabel(cat, "th")).toBe("วิศวกรรม");
    // An unsupported locale falls back to English rather than blank.
    expect(categoryLabel(cat, "fr")).toBe("Engineering");
  });

  it("collects distinct categories in first-appearance order", () => {
    const feed = normalizeFeed({
      jobs: [
        { ...VALID_JOB, id: "1", published_at: "2026-08-03T00:00:00Z" },
        {
          ...VALID_JOB,
          id: "2",
          published_at: "2026-08-02T00:00:00Z",
          category: { slug: "sales", name_en: "Sales", name_th: "ฝ่ายขาย" },
        },
        { ...VALID_JOB, id: "3", published_at: "2026-08-01T00:00:00Z" },
      ],
    });
    expect(collectCategories(feed.jobs).map((c) => c.slug)).toEqual([
      "engineering",
      "sales",
    ]);
  });

  it("filters by slug, and an unknown slug matches nothing", () => {
    const feed = normalizeFeed({
      jobs: [
        { ...VALID_JOB, id: "1" },
        {
          ...VALID_JOB,
          id: "2",
          category: { slug: "sales", name_en: "Sales" },
        },
      ],
    });
    expect(filterByCategory(feed.jobs, "sales")).toHaveLength(1);
    expect(filterByCategory(feed.jobs, "nope")).toHaveLength(0);
    expect(filterByCategory(feed.jobs, null)).toHaveLength(2);
  });
});

// ─── Employment type ────────────────────────────────────────

describe("employment type mapping", () => {
  it.each([
    ["full_time", "FULL_TIME"],
    ["full-time", "FULL_TIME"],
    ["PART_TIME", "PART_TIME"],
    ["contract", "CONTRACTOR"],
    ["internship", "INTERN"],
  ])("maps %j to the schema.org value %j", (input, expected) => {
    expect(toSchemaEmploymentType(input)).toBe(expected);
  });

  it("returns null for an unrecognized value rather than guessing", () => {
    expect(toSchemaEmploymentType("gig_economy_hustle")).toBeNull();
    expect(toSchemaEmploymentType(null)).toBeNull();
  });

  it("still keeps the raw value as a display label", () => {
    const job = normalizeJob({ ...VALID_JOB, employment_type: "weird_thing" });
    expect(job!.employmentType).toBe("weird_thing");
    expect(job!.employmentTypeSchema).toBeNull();
    expect(humanizeEmploymentType(job!.employmentType)).toBe("Weird thing");
  });

  it("humanizes null to null", () => {
    expect(humanizeEmploymentType(null)).toBeNull();
  });
});

// ─── Ordering + de-duplication ──────────────────────────────

describe("sortJobs — deterministic, newest first", () => {
  const make = (
    id: string,
    publishedAt: string | null,
    title = "T",
  ): CareersJob =>
    ({
      id,
      number: null,
      title,
      department: null,
      employmentType: null,
      employmentTypeSchema: null,
      location: null,
      category: null,
      salary: null,
      publishedAt,
      applyUrl: "https://e.com/a",
    }) satisfies CareersJob;

  it("orders newest first", () => {
    const sorted = sortJobs([
      make("a", "2026-01-01T00:00:00.000Z"),
      make("b", "2026-08-01T00:00:00.000Z"),
      make("c", "2026-05-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["b", "c", "a"]);
  });

  it("puts undated postings last", () => {
    const sorted = sortJobs([
      make("undated", null),
      make("dated", "2020-01-01T00:00:00.000Z"),
    ]);
    expect(sorted.map((j) => j.id)).toEqual(["dated", "undated"]);
  });

  it("breaks ties on title so the payload is cache-stable", () => {
    const iso = "2026-08-01T00:00:00.000Z";
    const first = sortJobs([make("a", iso, "Zebra"), make("b", iso, "Alpha")]);
    const second = sortJobs([make("b", iso, "Alpha"), make("a", iso, "Zebra")]);
    expect(first.map((j) => j.id)).toEqual(second.map((j) => j.id));
    expect(first[0]!.title).toBe("Alpha");
  });

  it("does not mutate its input", () => {
    const input = [make("a", "2020-01-01T00:00:00.000Z"), make("b", null)];
    const copy = [...input];
    sortJobs(input);
    expect(input).toEqual(copy);
  });
});

describe("de-duplication", () => {
  it("keeps only the first job for a repeated id", () => {
    const feed = normalizeFeed({
      jobs: [
        { ...VALID_JOB, title: "First" },
        { ...VALID_JOB, title: "Second" },
      ],
    });
    expect(feed.jobs).toHaveLength(1);
    expect(feed.jobs[0]!.title).toBe("First");
  });
});

// ─── parseFeedBody: malformed / empty / hostile bodies ──────

describe("parseFeedBody — never throws on any body", () => {
  it("parses a valid body and reports ok", () => {
    const result = parseFeedBody(JSON.stringify(VALID_FEED));
    expect(result.ok).toBe(true);
    expect(result.feed.jobs).toHaveLength(1);
  });

  it("reports an empty jobs array as ok, not as a failure", () => {
    // The distinction matters: "no openings" must be CACHED as a real
    // answer, while a parse failure must fall back to stale data.
    const result = parseFeedBody(JSON.stringify({ company: "X", jobs: [] }));
    expect(result.ok).toBe(true);
    expect(result.feed.jobs).toEqual([]);
    expect(result.feed.company).toBe("X");
  });

  it.each([
    ["truncated JSON", '{"company":"X","jobs":['],
    ["not JSON at all", "<html>502 Bad Gateway</html>"],
    ["empty body", ""],
    ["a JSON scalar", '"nope"'],
    ["JSON null", "null"],
    ["a JSON number", "7"],
  ])("returns ok:false and an empty feed for %s", (_label, body) => {
    const result = parseFeedBody(body);
    expect(result.ok).toBe(false);
    expect(result.feed.jobs).toEqual([]);
  });

  it("survives a valid envelope whose jobs field is the wrong type", () => {
    const result = parseFeedBody('{"company":"X","jobs":"lots"}');
    expect(result.ok).toBe(true);
    expect(result.feed.jobs).toEqual([]);
  });

  it("keeps the good jobs when only some entries are malformed", () => {
    const result = parseFeedBody(
      JSON.stringify({
        company: "X",
        jobs: [VALID_JOB, null, { id: "no-title" }, "junk", 42],
      }),
    );
    expect(result.ok).toBe(true);
    expect(result.feed.jobs).toHaveLength(1);
  });

  it("does not throw on a deeply nested or prototype-polluting payload", () => {
    const hostile = JSON.stringify({
      company: "X",
      jobs: [{ ...VALID_JOB, __proto__: { polluted: true } }],
    });
    expect(() => parseFeedBody(hostile)).not.toThrow();
    expect(
      (Object.prototype as unknown as { polluted?: boolean }).polluted,
    ).toBeUndefined();
  });
});

// ─── Cache envelope validation ──────────────────────────────

describe("parseCachedFeed — a cache entry is untrusted too", () => {
  it("accepts a well-formed entry", () => {
    const parsed = parseCachedFeed({
      v: 1,
      feed: normalizeFeed(VALID_FEED),
      fetchedAt: 1000,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.feed.jobs).toHaveLength(1);
    expect(parsed!.fetchedAt).toBe(1000);
  });

  it.each([
    ["a wrong version", { v: 99, feed: {}, fetchedAt: 1 }],
    ["a missing version", { feed: {}, fetchedAt: 1 }],
    ["a non-object feed", { v: 1, feed: "x", fetchedAt: 1 }],
    ["null", null],
    ["a bare string", "cached"],
  ])("rejects %s as a miss", (_label, input) => {
    expect(parseCachedFeed(input)).toBeNull();
  });

  it("re-normalizes on read, so a tampered entry cannot inject an unsafe URL", () => {
    const parsed = parseCachedFeed({
      v: 1,
      feed: {
        company: "X",
        jobs: [
          {
            id: "1",
            title: "Evil",
            apply_url: "javascript:alert(1)",
          },
        ],
      },
      fetchedAt: 1000,
    });
    expect(parsed!.feed.jobs).toHaveLength(0);
  });

  it("round-trips an already-normalized feed without losing jobs", () => {
    // Regression: `parseCachedFeed` re-normalizes, so normalization has
    // to be idempotent. It initially read only snake_case keys, which
    // meant every cached job silently vanished on read — the stale
    // fallback would have degraded to an empty page in exactly the
    // outage it exists to survive.
    const normalized = normalizeFeed(VALID_FEED);
    const roundTripped = parseCachedFeed({
      v: 1,
      feed: JSON.parse(JSON.stringify(normalized)),
      fetchedAt: 1000,
    });
    expect(roundTripped!.feed).toEqual(normalized);
  });

  it("coerces a non-numeric fetchedAt to 0, forcing a refetch", () => {
    const parsed = parseCachedFeed({
      v: 1,
      feed: normalizeFeed(VALID_FEED),
      fetchedAt: "yesterday",
    });
    expect(parsed!.fetchedAt).toBe(0);
  });
});

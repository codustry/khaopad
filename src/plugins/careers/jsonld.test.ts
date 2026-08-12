import { describe, expect, it } from "vitest";
import { normalizeFeed, type CareersJob } from "./feed";
import {
  buildCareersJsonLd,
  buildJobPostingJsonLd,
  escapeForScriptTag,
} from "./jsonld";

/**
 * #161 — JobPosting structured data. Two things matter beyond shape:
 *
 *  1. `baseSalary` appears ONLY when the feed supplied a salary.
 *     Fabricating a range for a posting that withheld one is a false
 *     claim in structured data.
 *  2. Nothing feed-supplied can break out of the <script> container.
 */

const SHARED = {
  siteOrigin: "https://codustry.com",
  organizationName: "Codustry",
  listingUrl: "https://codustry.com/en/careers",
};

function job(overrides: Partial<CareersJob> = {}): CareersJob {
  return {
    id: "job-1",
    number: "JOB-0001",
    title: "Full-stack Engineer",
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
    applyUrl: "https://app.tonbab.com/careers/codustry/job-1",
    ...overrides,
  };
}

describe("buildJobPostingJsonLd — required properties", () => {
  it("emits every property Google requires for a JobPosting", () => {
    const ld = buildJobPostingJsonLd({ job: job(), ...SHARED });
    expect(ld["@context"]).toBe("https://schema.org");
    expect(ld["@type"]).toBe("JobPosting");
    expect(ld.title).toBe("Full-stack Engineer");
    expect(ld.datePosted).toBe("2026-08-01T04:00:00.000Z");
    expect(ld.hiringOrganization).toEqual({
      "@type": "Organization",
      name: "Codustry",
      sameAs: "https://codustry.com",
    });
    // description is required — always present, even without a feed value.
    expect(typeof ld.description).toBe("string");
    expect((ld.description as string).length).toBeGreaterThan(0);
  });

  it("uses the feed description when one is supplied", () => {
    const ld = buildJobPostingJsonLd({
      job: job(),
      ...SHARED,
      description: "Build the thing.",
    });
    expect(ld.description).toBe("Build the thing.");
  });

  it("falls back to a factual synthesized description", () => {
    const ld = buildJobPostingJsonLd({ job: job(), ...SHARED });
    expect(ld.description).toContain("Full-stack Engineer");
    expect(ld.description).toContain("Codustry");
    expect(ld.description).toContain("Engineering");
  });

  it("ignores a blank description and falls back", () => {
    const ld = buildJobPostingJsonLd({
      job: job(),
      ...SHARED,
      description: "   ",
    });
    expect(ld.description).toContain("Full-stack Engineer");
  });

  it("points url at the apply page and mainEntityOfPage at the listing", () => {
    const ld = buildJobPostingJsonLd({ job: job(), ...SHARED });
    expect(ld.url).toBe("https://app.tonbab.com/careers/codustry/job-1");
    expect(ld.mainEntityOfPage).toEqual({
      "@type": "WebPage",
      "@id": "https://codustry.com/en/careers",
    });
  });
});

describe("buildJobPostingJsonLd — optional properties are omitted, not faked", () => {
  it("omits datePosted when the feed had no date", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ publishedAt: null }),
      ...SHARED,
    });
    expect(ld).not.toHaveProperty("datePosted");
  });

  it("omits employmentType when the raw value was unmappable", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ employmentTypeSchema: null }),
      ...SHARED,
    });
    expect(ld).not.toHaveProperty("employmentType");
  });

  it("omits jobLocation and occupationalCategory when absent", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ location: null, department: null }),
      ...SHARED,
    });
    expect(ld).not.toHaveProperty("jobLocation");
    expect(ld).not.toHaveProperty("occupationalCategory");
  });

  it("omits identifier when the feed had no reference number", () => {
    const ld = buildJobPostingJsonLd({ job: job({ number: null }), ...SHARED });
    expect(ld).not.toHaveProperty("identifier");
  });
});

describe("baseSalary — emitted only when the posting opted in", () => {
  it("is absent when the feed withheld salary", () => {
    const ld = buildJobPostingJsonLd({ job: job({ salary: null }), ...SHARED });
    expect(ld).not.toHaveProperty("baseSalary");
  });

  it("emits min/max for a real range", () => {
    const ld = buildJobPostingJsonLd({ job: job(), ...SHARED });
    expect(ld.baseSalary).toEqual({
      "@type": "MonetaryAmount",
      currency: "THB",
      value: {
        "@type": "QuantitativeValue",
        unitText: "MONTH",
        minValue: 60000,
        maxValue: 90000,
      },
    });
  });

  it("collapses an equal min and max to a single value", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ salary: { min: 70000, max: 70000, currency: "THB" } }),
      ...SHARED,
    });
    expect(ld.baseSalary).toMatchObject({
      value: { value: 70000 },
    });
    expect(ld.baseSalary).not.toMatchObject({ value: { minValue: 70000 } });
  });

  it("handles a one-sided range", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ salary: { min: 60000, max: null, currency: "THB" } }),
      ...SHARED,
    });
    expect(ld.baseSalary).toMatchObject({ value: { value: 60000 } });
  });

  it("carries the feed's currency through", () => {
    const ld = buildJobPostingJsonLd({
      job: job({ salary: { min: 5000, max: 7000, currency: "USD" } }),
      ...SHARED,
    });
    expect(ld.baseSalary).toMatchObject({ currency: "USD" });
  });

  it("never emits a zero salary for a posting that withheld one", () => {
    const serialized = JSON.stringify(
      buildJobPostingJsonLd({ job: job({ salary: null }), ...SHARED }),
    );
    expect(serialized).not.toContain("baseSalary");
  });
});

describe("script-tag safety", () => {
  it("escapes < so embedded markup cannot close the script tag", () => {
    expect(escapeForScriptTag('{"t":"</script>"}')).toBe(
      '{"t":"\\u003c/script>"}',
    );
  });

  it("neutralizes a </script> smuggled through a feed job title", () => {
    const feed = normalizeFeed({
      company: "Codustry",
      jobs: [
        {
          id: "1",
          title: "</script><img src=x onerror=alert(1)>",
          apply_url: "https://app.tonbab.com/a",
        },
      ],
    });
    const serialized = escapeForScriptTag(
      JSON.stringify(buildJobPostingJsonLd({ job: feed.jobs[0]!, ...SHARED })),
    );
    expect(serialized).not.toContain("</script>");
    expect(serialized).toContain("\\u003c/script>");
  });
});

describe("buildCareersJsonLd", () => {
  it("emits one node per opening", () => {
    const nodes = buildCareersJsonLd(
      [job({ id: "a" }), job({ id: "b" })],
      SHARED,
    );
    expect(nodes).toHaveLength(2);
    expect(nodes.every((n) => n["@type"] === "JobPosting")).toBe(true);
  });

  it("emits nothing for an empty listing", () => {
    expect(buildCareersJsonLd([], SHARED)).toEqual([]);
  });

  it("is deterministic — identical input serializes identically", () => {
    const once = JSON.stringify(buildCareersJsonLd([job()], SHARED));
    const twice = JSON.stringify(buildCareersJsonLd([job()], SHARED));
    expect(once).toBe(twice);
  });
});

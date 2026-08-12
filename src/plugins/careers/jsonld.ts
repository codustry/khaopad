/**
 * Schema.org `JobPosting` JSON-LD for careers openings.
 *
 * Follows `src/plugins/shop/jsonld.ts`: deterministic serialization
 * (no `Date.now()`, no randomness) and `<` escaped so a `</script>` in
 * feed-supplied text cannot break out of the JSON-LD container.
 *
 * Google's JobPosting rich result requires `title`, `description`,
 * `datePosted` and `hiringOrganization`. The current feed does not
 * expose a description (tracked upstream in codustry/workflow#937), so
 * we synthesize a short factual one from the fields we do have rather
 * than omit the property and fail validation outright. When the feed
 * starts sending `description`, pass it through and this fallback
 * stops being used.
 *
 * `baseSalary` is emitted ONLY when the feed provides a salary — the
 * posting opted into `show_salary` upstream. Inventing a salary range
 * for a posting that withheld one would be a fabricated claim in
 * structured data, which is exactly the kind of thing Google treats as
 * spam.
 */
import type { CareersJob } from "./feed";

export type JobPostingJsonLdInput = {
  job: CareersJob;
  /** Absolute site origin, e.g. "https://example.com". */
  siteOrigin: string;
  /** Hiring organization name — feed `company`, falling back to the site name. */
  organizationName: string;
  /** Absolute URL of the careers page this opening is listed on. */
  listingUrl: string;
  /** Optional description once the feed exposes one. */
  description?: string | null;
};

/**
 * Escape `<` in the serialized JSON so embedded markup cannot close
 * the surrounding `<script>` tag. Same guard as shop/jsonld.ts;
 * `JSON.stringify` does not do this for you.
 */
export function escapeForScriptTag(json: string): string {
  return json.replace(/</g, "\\u003c");
}

/**
 * Fallback description built from structured fields. Deliberately
 * plain — it exists to satisfy the required property honestly, not to
 * market the role.
 */
function fallbackDescription(job: CareersJob, org: string): string {
  const parts: string[] = [`${job.title} at ${org}.`];
  if (job.department) parts.push(`Department: ${job.department}.`);
  if (job.location) parts.push(`Location: ${job.location}.`);
  parts.push("See the application page for full details.");
  return parts.join(" ");
}

/**
 * Build one `JobPosting` node. Returned as a plain object so it can go
 * straight into `PageSeo.jsonLd`, which the <Seo /> component renders.
 */
export function buildJobPostingJsonLd(
  input: JobPostingJsonLdInput,
): Record<string, unknown> {
  const { job, organizationName, listingUrl } = input;

  const ld: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: job.title,
    description:
      input.description?.trim() || fallbackDescription(job, organizationName),
    hiringOrganization: {
      "@type": "Organization",
      name: organizationName,
      sameAs: input.siteOrigin,
    },
    // Where a candidate actually applies. The listing URL is the
    // canonical page the posting appears on.
    url: job.applyUrl,
    mainEntityOfPage: { "@type": "WebPage", "@id": listingUrl },
    directApply: false,
  };

  if (job.publishedAt) ld.datePosted = job.publishedAt;
  if (job.number)
    ld.identifier = {
      "@type": "PropertyValue",
      name: organizationName,
      value: job.number,
    };
  if (job.employmentTypeSchema) ld.employmentType = job.employmentTypeSchema;
  if (job.department) ld.occupationalCategory = job.department;

  // jobLocation is free text from the feed ("Bangkok / Remote"), so we
  // can only fill addressLocality — a fabricated country/postal code
  // would be worse than an incomplete address.
  if (job.location) {
    ld.jobLocation = {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: job.location },
    };
  }

  // Salary — present only when the posting opted in.
  if (job.salary && (job.salary.min !== null || job.salary.max !== null)) {
    const value: Record<string, unknown> = {
      "@type": "QuantitativeValue",
      // The feed gives monthly figures for Thai postings; there is no
      // unit field upstream, so MONTH is the documented assumption.
      unitText: "MONTH",
    };
    if (job.salary.min !== null && job.salary.max !== null) {
      if (job.salary.min === job.salary.max) {
        value.value = job.salary.min;
      } else {
        value.minValue = job.salary.min;
        value.maxValue = job.salary.max;
      }
    } else {
      value.value = job.salary.min ?? job.salary.max;
    }
    ld.baseSalary = {
      "@type": "MonetaryAmount",
      currency: job.salary.currency,
      value,
    };
  }

  return ld;
}

/** Build the JSON-LD array for a whole careers listing. */
export function buildCareersJsonLd(
  jobs: CareersJob[],
  shared: Omit<JobPostingJsonLdInput, "job" | "description">,
): Array<Record<string, unknown>> {
  return jobs.map((job) => buildJobPostingJsonLd({ ...shared, job }));
}

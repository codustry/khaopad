/**
 * Anonymous install telemetry — payload construction (#199).
 *
 * ## The bar we are building to
 *
 * There are two prior arts here and they are not equal. WordPress
 * appends the site's URL to the User-Agent of every update check, with
 * no opt-out; the practice has been contested since 2011
 * (core.trac.wordpress.org #16778) and spawned a plugin whose entire
 * purpose is stripping it. That is the bar we are NOT building to.
 *
 * Next.js and Astro are: the ping is anonymous by construction, carries
 * no identifier that can be resolved back to a site, is documented field
 * by field, and is disabled with one env var. That is this module.
 *
 * ## Anonymous BY CONSTRUCTION, not by promise
 *
 * The install id is random (`nanoid`), minted once and stored in site
 * settings. It is NOT derived from the hostname, the domain, the D1 id
 * or anything else about the deployment. That distinction matters more
 * than it looks: a *hash* of the domain would read as anonymous and be
 * trivially reversible — the set of live khaopad domains is small and
 * enumerable, so an attacker (or we ourselves, later, under pressure)
 * could dictionary-attack the hash back to the site in seconds. A
 * random id has no preimage to recover.
 *
 * ## What is deliberately absent
 *
 * No site URL, no hostname, no Host header, no D1/R2/KV ids, no user
 * ids, emails or names, no content, no titles, no slugs, no IP (we do
 * not store the connecting address at the collector), no exact counts.
 * Counts are bucketed precisely because an exact tuple ("847 articles,
 * 23 products, 4 users") is a fingerprint that re-identifies a site
 * across pings even without an id.
 */
import { nanoid } from "nanoid";
import type { ContentProvider } from "$lib/server/content/types";

/** Payload schema version. Bumped when fields are added or removed. */
export const TELEMETRY_PAYLOAD_VERSION = "1";

/** Settings key holding the random per-install id. */
export const TELEMETRY_INSTALL_ID_KEY = "telemetry.installId";

/** Settings key holding the operator's opt-in boolean. */
export const TELEMETRY_ENABLED_KEY = "telemetryEnabled";

/** Settings key holding the last successful send (ISO). */
export const TELEMETRY_LAST_SENT_KEY = "telemetry.lastSentAt";

/**
 * Coarse size buckets. Never an exact count — see the module header.
 * Boundaries are wide on purpose: the maintainer's question is "are
 * people running this for real?", which "11-100" answers as well as
 * "47" does, without the fingerprint.
 */
export type Bucket = "0" | "1-10" | "11-100" | "100+";

export function bucket(n: number): Bucket {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n <= 10) return "1-10";
  if (n <= 100) return "11-100";
  return "100+";
}

/**
 * The complete wire payload. Every field here is documented in
 * docs/TELEMETRY.md; adding one without documenting it is a bug, and
 * `telemetry-payload.node.test.ts` pins the key set so a silent
 * addition fails CI.
 */
export interface TelemetryPayload {
  /** Payload schema version, not the engine version. */
  payloadVersion: string;
  /** Random per-install id. Identifies an INSTALL, never a person or domain. */
  installId: string;
  /** Engine version from package.json, e.g. "4.4.0". */
  engineVersion: string;
  /** Theme-contract version, e.g. "1.0.0". */
  contractVersion: string;
  /** Coarse runtime label — "cloudflare-workers" or "node". No versions/paths. */
  runtime: string;
  /** Slugs of enabled OPTIONAL plugins, e.g. ["shop"]. Engine-defined names only. */
  plugins: string[];
  /** How many locales the site serves. A count, never the locale names. */
  localeCount: number;
  /** Coarse content-scale buckets. */
  buckets: {
    articles: Bucket;
    pages: Bucket;
    users: Bucket;
  };
  /**
   * Cloudflare colo region (e.g. "APAC"), when the platform hands it
   * over for free. Continent-scale only — never country, city, lat/lon
   * or the colo code itself, all of which narrow a site far too much.
   */
  region?: string;
  /**
   * Deployment environment — "production", "preview" or "development".
   *
   * The signal that separates real adoption from someone running
   * `pnpm dev` twice. Without it every localhost experiment counts as
   * an install and the adoption numbers are noise. Derived from
   * WORKERS_ENV; unknown values collapse to "development" so a
   * misconfigured deployment cannot inflate production counts.
   */
  environment: "production" | "preview" | "development";
  /**
   * Whether the site is served from a custom domain, as a BOOLEAN.
   *
   * The strongest "this is a real deployment" signal available — but
   * the domain ITSELF is never sent. A hostname identifies the
   * operator's business, which is exactly the line this payload does
   * not cross; the boolean carries the signal with none of the
   * identity.
   */
  hasCustomDomain: boolean;
}

/** The exact set of top-level keys. Pinned by test. */
export const TELEMETRY_PAYLOAD_KEYS = [
  "payloadVersion",
  "installId",
  "engineVersion",
  "contractVersion",
  "runtime",
  "plugins",
  "localeCount",
  "buckets",
  "region",
  "environment",
  "hasCustomDomain",
] as const;

/**
 * Mint a fresh random install id.
 *
 * Exported so the test can assert two calls never agree — the guard
 * against someone "helpfully" replacing this with a hash of the
 * hostname later.
 */
export function mintInstallId(): string {
  return nanoid(21);
}

/**
 * Read the install id from settings, minting and persisting one on
 * first run.
 *
 * Never throws: a settings failure yields `null` and the caller skips
 * the ping entirely. Telemetry must not be able to break anything.
 */
export async function resolveInstallId(
  content: Pick<ContentProvider, "getSettings" | "updateSettings">,
): Promise<string | null> {
  try {
    const settings = (await content.getSettings()) as Record<string, unknown>;
    const existing = settings[TELEMETRY_INSTALL_ID_KEY];
    if (typeof existing === "string" && existing.length >= 16) return existing;
    const minted = mintInstallId();
    await content.updateSettings({
      [TELEMETRY_INSTALL_ID_KEY]: minted,
    } as never);
    return minted;
  } catch {
    return null;
  }
}

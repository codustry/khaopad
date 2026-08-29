/**
 * Anonymous install telemetry — the sender (#199).
 *
 * See `payload.ts` for the privacy design and `docs/TELEMETRY.md` for
 * the operator-facing contract.
 *
 * ## Default is OFF
 *
 * `telemetryEnabled` absent means disabled. Khaopad forks are typically
 * commercial client sites built by agencies for Thai SMEs; the operator
 * running the site is not the person who chose to build on khaopad, and
 * silently phoning home from someone's client's production deployment
 * is not a decision an engine gets to make for them. Opt-in costs the
 * maintainer some sample size and costs the operator nothing.
 *
 * ## Three independent ways to stay silent
 *
 * 1. The setting is absent/false (the default).
 * 2. `KHAOPAD_TELEMETRY_DISABLED=1` in the environment — a hard veto
 *    that overrides the setting, so an operator who cannot reach the
 *    admin UI (CI, a locked-down deploy) can still guarantee silence.
 * 3. No `TELEMETRY_ENDPOINT` configured — nothing to send to.
 *
 * ## Never blocks, never breaks
 *
 * Called from the scheduled/cron path only — never from a user request,
 * so no visitor ever waits on it. Hard 3s timeout via AbortSignal, and
 * every failure path is swallowed. A telemetry bug must degrade to
 * "no data was collected", never to a 500 or a slow page.
 */
import {
  bucket,
  resolveInstallId,
  TELEMETRY_ENABLED_KEY,
  TELEMETRY_LAST_SENT_KEY,
  TELEMETRY_PAYLOAD_VERSION,
  type TelemetryPayload,
} from "./payload";
import { THEME_CONTRACT_VERSION } from "$lib/theme-contract";
import { normalizeEnabledPlugins } from "$lib/plugins/optional";
import type { ContentProvider } from "$lib/server/content/types";

/** Hard ceiling on the request. Cron has budget; we still don't use it. */
const TIMEOUT_MS = 3000;

/** Weekly. Daily would be noise — adoption does not move that fast. */
export const SEND_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** Engine version. Sourced from package.json at build time. */
export const ENGINE_VERSION = "4.4.0";

/**
 * Env veto. Any non-empty value other than "0"/"false" disables — the
 * documented spelling is `1`, but an operator typing `true` clearly
 * means the same thing and must not be silently ignored.
 */
export function isDisabledByEnv(env: Record<string, unknown> | undefined) {
  const raw = env?.KHAOPAD_TELEMETRY_DISABLED;
  if (raw === undefined || raw === null) return false;
  const s = String(raw).trim().toLowerCase();
  if (s === "" || s === "0" || s === "false") return false;
  return true;
}

/**
 * Coarse continent from Cloudflare's request metadata, when present.
 * Country is deliberately dropped: "TH" plus a plugin set plus a
 * bucket tuple narrows a site much further than "APAC" does.
 */
function coarseRegion(continent: unknown): string | undefined {
  if (typeof continent !== "string" || continent.length !== 2) return undefined;
  const map: Record<string, string> = {
    AF: "AFRICA",
    AN: "ANTARCTICA",
    AS: "APAC",
    EU: "EUROPE",
    NA: "NAMER",
    OC: "APAC",
    SA: "SAMER",
  };
  return map[continent.toUpperCase()];
}

export interface BuildPayloadInput {
  content: Pick<ContentProvider, "getSettings" | "updateSettings">;
  counts: { articles: number; pages: number; users: number };
  runtime: string;
  continent?: unknown;
  /** Raw WORKERS_ENV (or equivalent). Normalised, never sent verbatim. */
  workersEnv?: unknown;
  /** The site's configured public origin. Used ONLY to derive a boolean. */
  publicSiteUrl?: unknown;
}

/**
 * Normalise the deployment environment to one of three labels.
 *
 * Anything unrecognised collapses to "development", deliberately: a
 * misconfigured or absent WORKERS_ENV must not be able to inflate the
 * production install count. Only an explicit, known production marker
 * counts as production.
 */
export function normalizeEnvironment(
  raw: unknown,
): "production" | "preview" | "development" {
  const v = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (v === "production" || v === "prod") return "production";
  if (v === "preview" || v === "staging") return "preview";
  return "development";
}

/**
 * Does this deployment sit on a real custom domain?
 *
 * Returns a BOOLEAN and nothing else — the hostname is inspected here
 * and immediately discarded. `*.workers.dev`, localhost and any
 * unparseable value are all "no", which is what separates a tyre-kick
 * from a deployment someone has committed a domain to.
 */
export function derivesCustomDomain(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string" || !rawUrl) return false;
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!host || host === "localhost" || host.endsWith(".local")) return false;
  if (host.endsWith(".workers.dev") || host.endsWith(".pages.dev"))
    return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false; // bare IP
  if (host === "example.com" || host.endsWith(".example.com")) return false;
  return host.includes(".");
}

/**
 * Assemble the wire payload. Returns null when no install id could be
 * resolved (settings unavailable) — the caller then sends nothing.
 */
export async function buildPayload(
  input: BuildPayloadInput,
): Promise<TelemetryPayload | null> {
  const installId = await resolveInstallId(input.content);
  if (!installId) return null;

  let plugins: string[] = [];
  let localeCount = 0;
  try {
    const settings = await input.content.getSettings();
    plugins = [...normalizeEnabledPlugins(settings.enabledPlugins)];
    localeCount = Array.isArray(settings.supportedLocales)
      ? settings.supportedLocales.length
      : 0;
  } catch {
    /* best effort — an empty plugin list is a fine answer */
  }

  const region = coarseRegion(input.continent);
  return {
    environment: normalizeEnvironment(input.workersEnv),
    hasCustomDomain: derivesCustomDomain(input.publicSiteUrl),
    payloadVersion: TELEMETRY_PAYLOAD_VERSION,
    installId,
    engineVersion: ENGINE_VERSION,
    contractVersion: THEME_CONTRACT_VERSION,
    runtime: input.runtime,
    plugins,
    localeCount,
    buckets: {
      articles: bucket(input.counts.articles),
      pages: bucket(input.counts.pages),
      users: bucket(input.counts.users),
    },
    ...(region ? { region } : {}),
  };
}

/** Has enough time passed since the last successful send? */
export function isDue(lastSentAt: unknown, now = Date.now()): boolean {
  if (typeof lastSentAt !== "string" || !lastSentAt) return true;
  const t = Date.parse(lastSentAt);
  if (Number.isNaN(t)) return true;
  return now - t >= SEND_INTERVAL_MS;
}

export interface MaybeSendResult {
  sent: boolean;
  /** Why nothing was sent. Present only when `sent` is false. */
  reason?:
    | "env-disabled"
    | "not-enabled"
    | "no-endpoint"
    | "not-due"
    | "failed";
}

/**
 * The whole thing. Safe to call unconditionally from cron.
 *
 * Every branch that returns `sent: false` is a normal outcome, not an
 * error — nothing here ever throws to its caller.
 */
export async function maybeSendTelemetry(opts: {
  env: Record<string, unknown> | undefined;
  content: Pick<ContentProvider, "getSettings" | "updateSettings">;
  counts: { articles: number; pages: number; users: number };
  runtime?: string;
  continent?: unknown;
  fetchImpl?: typeof fetch;
  now?: number;
}): Promise<MaybeSendResult> {
  try {
    if (isDisabledByEnv(opts.env))
      return { sent: false, reason: "env-disabled" };

    const endpoint = opts.env?.TELEMETRY_ENDPOINT;
    if (typeof endpoint !== "string" || !endpoint) {
      return { sent: false, reason: "no-endpoint" };
    }

    let settings: Record<string, unknown>;
    try {
      settings = (await opts.content.getSettings()) as Record<string, unknown>;
    } catch {
      return { sent: false, reason: "not-enabled" };
    }

    if (settings[TELEMETRY_ENABLED_KEY] !== true) {
      return { sent: false, reason: "not-enabled" };
    }
    if (!isDue(settings[TELEMETRY_LAST_SENT_KEY], opts.now ?? Date.now())) {
      return { sent: false, reason: "not-due" };
    }

    const payload = await buildPayload({
      content: opts.content,
      counts: opts.counts,
      runtime: opts.runtime ?? "cloudflare-workers",
      continent: opts.continent,
      // Both come from the deployment's own [vars]; each is reduced to a
      // label or a boolean inside buildPayload and never sent verbatim.
      workersEnv: opts.env?.WORKERS_ENV,
      publicSiteUrl: opts.env?.PUBLIC_SITE_URL,
    });
    if (!payload) return { sent: false, reason: "failed" };

    const doFetch = opts.fetchImpl ?? fetch;
    const res = await doFetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res || !res.ok) return { sent: false, reason: "failed" };

    try {
      await opts.content.updateSettings({
        [TELEMETRY_LAST_SENT_KEY]: new Date(
          opts.now ?? Date.now(),
        ).toISOString(),
      } as never);
    } catch {
      /* the ping landed; failing to record that is not worth a retry storm */
    }
    return { sent: true };
  } catch {
    // Fail silent, by contract.
    return { sent: false, reason: "failed" };
  }
}

export * from "./payload";

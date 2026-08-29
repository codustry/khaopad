/**
 * Telemetry privacy pins (#199).
 *
 * These tests are the enforcement behind docs/TELEMETRY.md. Each one
 * corresponds to a promise in that document, so a change that quietly
 * breaks a promise fails CI rather than shipping.
 */
import { describe, it, expect } from "vitest";
import {
  bucket,
  mintInstallId,
  resolveInstallId,
  TELEMETRY_PAYLOAD_KEYS,
  TELEMETRY_INSTALL_ID_KEY,
} from "./payload";
import type { ContentProvider, SiteSettings } from "$lib/server/content/types";
import {
  buildPayload,
  isDisabledByEnv,
  isDue,
  maybeSendTelemetry,
  SEND_INTERVAL_MS,
} from "./index";

/**
 * Minimal in-memory stand-in for the settings half of ContentProvider.
 *
 * Typed as the real `Pick<...>` so these tests exercise the same
 * signature production does — a loosely-typed fake would let a payload
 * regression type-check here and fail only at runtime.
 */
type SettingsPort = Pick<ContentProvider, "getSettings" | "updateSettings">;

function fakeContent(initial: Record<string, unknown> = {}) {
  const store: Record<string, unknown> = {
    siteName: "Test",
    defaultLocale: "en",
    supportedLocales: ["en", "th"],
    ...initial,
  };
  const port: SettingsPort & { store: Record<string, unknown> } = {
    store,
    getSettings: async () => ({ ...store }) as unknown as SiteSettings,
    updateSettings: async (d: Partial<SiteSettings>) => {
      Object.assign(store, d);
      return { ...store } as unknown as SiteSettings;
    },
  };
  return port;
}

/** A settings port whose every call rejects — the "D1 is down" case. */
function brokenContent(): SettingsPort {
  return {
    getSettings: async () => {
      throw new Error("D1 down");
    },
    updateSettings: async () => {
      throw new Error("D1 down");
    },
  };
}

const COUNTS = { articles: 47, pages: 3, users: 2 };

describe("buckets", () => {
  it("never reveals an exact count", () => {
    expect(bucket(0)).toBe("0");
    expect(bucket(1)).toBe("1-10");
    expect(bucket(10)).toBe("1-10");
    expect(bucket(11)).toBe("11-100");
    expect(bucket(100)).toBe("11-100");
    expect(bucket(101)).toBe("100+");
    expect(bucket(999999)).toBe("100+");
  });

  it("treats nonsense as zero rather than throwing", () => {
    expect(bucket(NaN)).toBe("0");
    expect(bucket(-5)).toBe("0");
  });
});

describe("install id", () => {
  it("is random, not derived from anything identifying", () => {
    // The guard against someone 'helpfully' replacing this with a hash
    // of the hostname: two mints must never agree.
    const ids = new Set(Array.from({ length: 500 }, () => mintInstallId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{21}$/);
  });

  it("mints once and then reuses the stored value", async () => {
    const content = fakeContent();
    const first = await resolveInstallId(content);
    const second = await resolveInstallId(content);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(content.store[TELEMETRY_INSTALL_ID_KEY]).toBe(first);
  });

  it("returns null instead of throwing when settings are unavailable", async () => {
    await expect(resolveInstallId(brokenContent())).resolves.toBeNull();
  });
});

describe("payload contains no PII", () => {
  it("carries exactly the documented keys and no others", async () => {
    const payload = await buildPayload({
      content: fakeContent({ enabledPlugins: ["shop"] }),
      counts: COUNTS,
      runtime: "cloudflare-workers",
      continent: "AS",
    });
    expect(payload).not.toBeNull();
    const keys = Object.keys(payload!).sort();
    const allowed = [...TELEMETRY_PAYLOAD_KEYS].sort();
    for (const k of keys) expect(allowed).toContain(k);
  });

  it("leaks no hostname, url, ip, user or content anywhere in the wire form", async () => {
    const content = fakeContent({
      enabledPlugins: ["shop"],
      // Realistic identifying settings that must NOT reach the wire.
      siteName: "Somchai Noodles Co Ltd",
      cdnBaseUrl: "https://cdn.somchai-noodles.co.th",
      cfaToken: "super-secret-beacon-token",
      merchantTaxId: "0105558123456",
      shopNotifyEmail: "owner@somchai-noodles.co.th",
      "newsletter.resendKey": "re_live_abc123",
    });
    const payload = await buildPayload({
      content,
      counts: COUNTS,
      runtime: "cloudflare-workers",
      continent: "AS",
    });
    const wire = JSON.stringify(payload);

    for (const forbidden of [
      "somchai",
      "noodles",
      ".co.th",
      "https://",
      "cdn",
      "@",
      "0105558123456",
      "re_live",
      "super-secret",
      "Somchai Noodles Co Ltd",
    ]) {
      expect(wire.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("bucketizes counts rather than sending them", async () => {
    const payload = await buildPayload({
      content: fakeContent(),
      counts: COUNTS,
      runtime: "cloudflare-workers",
    });
    expect(payload!.buckets).toEqual({
      articles: "11-100",
      pages: "1-10",
      users: "1-10",
    });
    // The exact numbers must appear nowhere on the wire.
    const wire = JSON.stringify(payload);
    expect(wire).not.toContain("47");
    expect(wire).not.toContain('"3"');
  });

  it("coarsens location to a continent and drops anything finer", async () => {
    const mk = async (continent: unknown) =>
      (
        await buildPayload({
          content: fakeContent(),
          counts: COUNTS,
          runtime: "cloudflare-workers",
          continent,
        })
      )?.region;

    expect(await mk("AS")).toBe("APAC");
    expect(await mk("EU")).toBe("EUROPE");
    // A country code, a colo code or coordinates are not continents and
    // must be dropped rather than passed through.
    expect(await mk("TH")).toBeUndefined();
    expect(await mk("BKK")).toBeUndefined();
    expect(await mk(13.7563)).toBeUndefined();
    expect(await mk(undefined)).toBeUndefined();
  });

  it("sends only engine-defined plugin slugs, never arbitrary settings values", async () => {
    const payload = await buildPayload({
      content: fakeContent({
        enabledPlugins: [
          "shop",
          "definitely-not-installed",
          "../../etc/passwd",
        ],
      }),
      counts: COUNTS,
      runtime: "cloudflare-workers",
    });
    expect(payload!.plugins).toEqual(["shop"]);
  });
});

describe("opt-out is honoured", () => {
  const enabledContent = () =>
    fakeContent({ telemetryEnabled: true, enabledPlugins: [] });

  function spyFetch() {
    const calls: string[] = [];
    const impl = (async (url: string) => {
      calls.push(String(url));
      return { ok: true } as Response;
    }) as unknown as typeof fetch;
    return { calls, impl };
  }

  it("sends when the operator has opted in", async () => {
    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: enabledContent(),
      counts: COUNTS,
      fetchImpl: impl,
    });
    expect(res).toEqual({ sent: true });
    expect(calls).toHaveLength(1);
  });

  it("sends nothing by default — an install that never opted in is silent", async () => {
    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: fakeContent(), // telemetryEnabled absent
      counts: COUNTS,
      fetchImpl: impl,
    });
    expect(res).toEqual({ sent: false, reason: "not-enabled" });
    expect(calls).toHaveLength(0);
  });

  it("honours the setting being switched back off", async () => {
    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: fakeContent({ telemetryEnabled: false }),
      counts: COUNTS,
      fetchImpl: impl,
    });
    expect(res).toEqual({ sent: false, reason: "not-enabled" });
    expect(calls).toHaveLength(0);
  });

  it("honours KHAOPAD_TELEMETRY_DISABLED even when the setting says yes", async () => {
    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: {
        TELEMETRY_ENDPOINT: "https://collector.test/v1/ping",
        KHAOPAD_TELEMETRY_DISABLED: "1",
      },
      content: enabledContent(),
      counts: COUNTS,
      fetchImpl: impl,
    });
    expect(res).toEqual({ sent: false, reason: "env-disabled" });
    expect(calls).toHaveLength(0);
  });

  it("reads the env veto forgivingly but does not disable on absent/0/false", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on"]) {
      expect(isDisabledByEnv({ KHAOPAD_TELEMETRY_DISABLED: v })).toBe(true);
    }
    for (const v of ["", "0", "false", "False"]) {
      expect(isDisabledByEnv({ KHAOPAD_TELEMETRY_DISABLED: v })).toBe(false);
    }
    expect(isDisabledByEnv({})).toBe(false);
    expect(isDisabledByEnv(undefined)).toBe(false);
  });

  it("sends nothing when no endpoint is configured", async () => {
    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: {},
      content: enabledContent(),
      counts: COUNTS,
      fetchImpl: impl,
    });
    expect(res).toEqual({ sent: false, reason: "no-endpoint" });
    expect(calls).toHaveLength(0);
  });

  it("throttles to weekly", async () => {
    const now = Date.UTC(2026, 0, 20);
    const recent = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now - SEND_INTERVAL_MS - 1000).toISOString();

    expect(isDue(undefined, now)).toBe(true);
    expect(isDue(recent, now)).toBe(false);
    expect(isDue(old, now)).toBe(true);
    expect(isDue("not-a-date", now)).toBe(true);

    const { calls, impl } = spyFetch();
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: fakeContent({
        telemetryEnabled: true,
        "telemetry.lastSentAt": recent,
      }),
      counts: COUNTS,
      fetchImpl: impl,
      now,
    });
    expect(res).toEqual({ sent: false, reason: "not-due" });
    expect(calls).toHaveLength(0);
  });
});

describe("failure is silent", () => {
  it("never throws when the collector is unreachable", async () => {
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: fakeContent({ telemetryEnabled: true }),
      counts: COUNTS,
      fetchImpl: (async () => {
        throw new Error("network unreachable");
      }) as unknown as typeof fetch,
    });
    expect(res).toEqual({ sent: false, reason: "failed" });
  });

  it("never throws when the collector returns an error status", async () => {
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: fakeContent({ telemetryEnabled: true }),
      counts: COUNTS,
      fetchImpl: (async () =>
        ({ ok: false }) as Response) as unknown as typeof fetch,
    });
    expect(res).toEqual({ sent: false, reason: "failed" });
  });

  it("never throws when settings are unreadable", async () => {
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content: brokenContent(),
      counts: COUNTS,
      fetchImpl: (async () =>
        ({ ok: true }) as Response) as unknown as typeof fetch,
    });
    expect(res.sent).toBe(false);
  });

  it("still reports success when only the bookkeeping write fails", async () => {
    const content = fakeContent({ telemetryEnabled: true });
    let writes = 0;
    content.updateSettings = async (d: Partial<SiteSettings>) => {
      writes++;
      // Let the install-id mint through; fail the lastSentAt write.
      if ("telemetry.lastSentAt" in d) throw new Error("D1 down");
      Object.assign(content.store, d);
      return { ...content.store } as unknown as SiteSettings;
    };
    const res = await maybeSendTelemetry({
      env: { TELEMETRY_ENDPOINT: "https://collector.test/v1/ping" },
      content,
      counts: COUNTS,
      fetchImpl: (async () =>
        ({ ok: true }) as Response) as unknown as typeof fetch,
    });
    expect(res).toEqual({ sent: true });
    expect(writes).toBeGreaterThan(0);
  });
});

/**
 * Admin payment health (v4.6.0). Uses env-var credentials so no secret
 * lookup touches D1 — the DB-backed states are covered in the secrets
 * service integration tests.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beamMode,
  getBeamHealth,
  recordWebhookReceived,
  testBeamConnection,
} from "./payment-health.server";

afterEach(() => vi.unstubAllGlobals());

function kv() {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    put: async (k: string, v: string) => void store.set(k, v),
  } as unknown as KVNamespace;
}

const configured = (extra: Record<string, unknown> = {}) => ({
  DB: {} as D1Database,
  BEAM_MERCHANT_ID: "m",
  BEAM_API_KEY: "k",
  BEAM_WEBHOOK_SECRET: "w",
  CONTENT_CACHE: kv(),
  ...extra,
});

describe("beamMode", () => {
  it("knows live, playground and anything else", () => {
    expect(beamMode(undefined)).toBe("live");
    expect(beamMode("https://api.beamcheckout.com")).toBe("live");
    expect(beamMode("https://playground.api.beamcheckout.com")).toBe(
      "playground",
    );
    expect(beamMode("http://localhost:8799")).toBe("custom");
  });
});

describe("getBeamHealth", () => {
  it("reports configured, mode, and no webhook yet", async () => {
    const h = await getBeamHealth(
      configured({ BEAM_BASE_URL: "https://playground.api.beamcheckout.com" }),
    );
    expect(h).toMatchObject({
      mode: "playground",
      configured: true,
      missing: [],
      undecryptable: [],
      lastWebhookAt: null,
    });
  });

  it("shows when the last verified webhook arrived", async () => {
    const env = configured();
    await recordWebhookReceived(env, "beam", new Date("2026-10-25T08:00:00Z"));
    expect((await getBeamHealth(env)).lastWebhookAt).toBe(
      "2026-10-25T08:00:00.000Z",
    );
  });

  it("flags a lookalike env var the code doesn't read", async () => {
    const h = await getBeamHealth(configured({ BEAM_SECRET_KEY: "legacy" }));
    expect(h.unread).toEqual(["BEAM_SECRET_KEY"]);
  });

  it("recording never throws, even without KV", async () => {
    await expect(recordWebhookReceived({}, "beam")).resolves.toBeUndefined();
  });
});

describe("testBeamConnection", () => {
  const reply = (status: number) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: status === 200,
        status,
        json: async () => ({ data: [] }),
      })),
    );

  it("200 → accepted, with one read-only GET", async () => {
    reply(200);
    expect(await testBeamConnection(configured())).toEqual({
      ok: true,
      status: 200,
    });
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0] as [string, RequestInit | undefined];
    expect(url).toBe("https://api.beamcheckout.com/api/v1/charges?limit=1");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("401 → rejected", async () => {
    reply(401);
    expect(await testBeamConnection(configured())).toEqual({
      ok: false,
      status: 401,
    });
  });

  it("unreachable → status 0", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    expect(await testBeamConnection(configured())).toEqual({
      ok: false,
      status: 0,
    });
  });
});

describe("the webhook route records arrival only after verifying", () => {
  it("calls recordWebhookReceived after the signature check", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../routes/api/shop/webhook/beam/+server.ts", import.meta.url),
      "utf8",
    );
    const verifiedAt = src.indexOf("if (!verified.ok)");
    const recordAt = src.indexOf("await recordWebhookReceived(");
    expect(verifiedAt).toBeGreaterThan(0);
    expect(recordAt).toBeGreaterThan(verifiedAt);
  });
});

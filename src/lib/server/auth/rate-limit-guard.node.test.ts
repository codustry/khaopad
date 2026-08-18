/**
 * Pins the credential-endpoint rate-limit guard (#182, second attempt).
 *
 * The FIRST attempt (KV-backed storage) passed every local test and did
 * nothing in production: KV caches reads for >= 60s, so 10s-window counters
 * never accumulate — miniflare's strongly-consistent KV made local
 * verification lie. These tests therefore exercise the guard with a fake
 * binding; the production proof is spaced wrong-password attempts against
 * the DEPLOYED demo returning 429, which is recorded in the PR.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { guardedAuthHandler } from "./rate-limit-guard";

const fakeAuth = (status = 200) =>
  ({
    handler: async () => new Response(JSON.stringify({ ok: true }), { status }),
  }) as never;

const req = (path: string) =>
  new Request(`https://shop.example${path}`, {
    method: "POST",
    headers: { "cf-connecting-ip": "203.0.113.7" },
  });

describe("guardedAuthHandler", () => {
  it("blocks a guarded path when the limiter says no", async () => {
    const limiter = { limit: async () => ({ success: false }) };
    const res = await guardedAuthHandler(
      fakeAuth(),
      req("/api/auth/sign-in/email"),
      limiter,
    );
    expect(res.status).toBe(429);
    expect(((await res.json()) as { message: string }).message).toMatch(
      /Too many attempts/,
    );
  });

  it("passes a guarded path through when the limiter allows", async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    };
    const res = await guardedAuthHandler(
      fakeAuth(),
      req("/api/auth/change-password"),
      limiter,
    );
    expect(res.status).toBe(200);
    // Keyed by ip|path so one abusive IP cannot exhaust another's budget.
    expect(keys).toEqual(["203.0.113.7|/change-password"]);
  });

  it("never consults the limiter for unguarded paths", async () => {
    // Session reads happen on every page load; throttling them would lock
    // legitimate users out for zero security gain.
    let called = 0;
    const limiter = {
      limit: async () => {
        called++;
        return { success: false };
      },
    };
    const res = await guardedAuthHandler(
      fakeAuth(),
      req("/api/auth/get-session"),
      limiter,
    );
    expect(res.status).toBe(200);
    expect(called).toBe(0);
  });

  it("fails OPEN when the binding is absent", async () => {
    // Local vite dev, tests, and forks without the binding: the request
    // proceeds and Better Auth's KV-backed limiter remains underneath.
    const res = await guardedAuthHandler(
      fakeAuth(),
      req("/api/auth/sign-in/email"),
      undefined,
    );
    expect(res.status).toBe(200);
  });

  it("fails OPEN when the binding throws", async () => {
    const limiter = {
      limit: async () => {
        throw new Error("colo hiccup");
      },
    };
    const res = await guardedAuthHandler(
      fakeAuth(),
      req("/api/auth/sign-in/email"),
      limiter,
    );
    expect(res.status).toBe(200);
  });
});

describe("call-site wiring", () => {
  const root = process.cwd();
  it("BOTH auth.handler call sites go through the guard", () => {
    // The profile action calls auth.handler internally and never touches
    // the /api/auth route — a route-level-only guard would silently miss
    // it, which is the same class of mistake as review finding H1.
    const route = readFileSync(
      join(root, "src/routes/api/auth/[...all]/+server.ts"),
      "utf8",
    );
    const profile = readFileSync(
      join(root, "src/routes/(admin)/admin/profile/+page.server.ts"),
      "utf8",
    );
    expect(route).toContain("guardedAuthHandler");
    expect(profile).toContain("guardedAuthHandler");
    expect(route).not.toMatch(/return auth\.handler\(/);
    expect(profile).not.toMatch(/await auth\.handler\(/);
  });
});

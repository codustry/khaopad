/**
 * resolveOrigin decides the host every canonical, hreflang, og:url,
 * og:image, sitemap and feed URL is built on. Until v4.6.0 the routes
 * passed the admin's `cdnBaseUrl` media setting, and a store that
 * filled it in (bactrack.in.th) pointed all of those at a CDN host
 * serving no pages. These pin the precedence and keep the setting out.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveOrigin } from "./index";

const req = new URL("https://khaopad-example.codustry.workers.dev/th/blog?x=1");

describe("resolveOrigin", () => {
  it("prefers the configured site URL over the request host", () => {
    expect(resolveOrigin(req, "https://www.example.com")).toBe(
      "https://www.example.com",
    );
  });

  it("reduces a site URL with a path or trailing slash to its origin", () => {
    expect(resolveOrigin(req, "https://www.example.com/")).toBe(
      "https://www.example.com",
    );
    expect(resolveOrigin(req, "https://www.example.com/shop/")).toBe(
      "https://www.example.com",
    );
  });

  it("falls back to the request origin when unset or not http(s)", () => {
    const origin = "https://khaopad-example.codustry.workers.dev";
    expect(resolveOrigin(req, undefined)).toBe(origin);
    expect(resolveOrigin(req, "")).toBe(origin);
    expect(resolveOrigin(req, "www.example.com")).toBe(origin);
    expect(resolveOrigin(req, "https://")).toBe(origin);
  });
});

describe("no route builds page URLs from the CDN media setting", () => {
  const root = new URL("../../routes", import.meta.url).pathname;
  const files: string[] = [];
  (function walk(dir: string) {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name))
        files.push(p);
    }
  })(root);

  it("finds the routes that call resolveOrigin", () => {
    const callers = files.filter((f) =>
      readFileSync(f, "utf8").includes("resolveOrigin("),
    );
    expect(callers.length).toBeGreaterThanOrEqual(15);
  });

  it("never passes cdnBaseUrl as the origin", () => {
    const offenders = files.filter((f) =>
      /resolveOrigin\([^)]*cdnBaseUrl/s.test(readFileSync(f, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";
import { requireSameOrigin } from "./same-origin";

const URL_ = new URL("https://shop.example/api/shop/cart");
const req = (method: string, headers: Record<string, string> = {}) =>
  new Request("https://shop.example/api/shop/cart", { method, headers });

describe("requireSameOrigin", () => {
  it("allows read-only methods without provenance", () => {
    expect(requireSameOrigin(req("GET"), URL_)).toBeNull();
    expect(requireSameOrigin(req("HEAD"), URL_)).toBeNull();
  });

  it("REJECTS a state change with no Origin at all", () => {
    // The bug: `cart` waved this through on the reasoning that
    // same-origin fetches omit Origin. Browsers have sent it on every
    // POST since ~2020, so an absent header means a non-browser client.
    const res = requireSameOrigin(req("POST"), URL_);
    expect(res?.status).toBe(403);
  });

  it("allows a same-origin POST", () => {
    expect(
      requireSameOrigin(req("POST", { origin: "https://shop.example" }), URL_),
    ).toBeNull();
  });

  it("rejects a cross-origin POST", () => {
    const res = requireSameOrigin(
      req("POST", { origin: "https://evil.example" }),
      URL_,
    );
    expect(res?.status).toBe(403);
  });

  it("rejects a malformed Origin rather than throwing", () => {
    const res = requireSameOrigin(req("POST", { origin: "not a url" }), URL_);
    expect(res?.status).toBe(400);
  });

  it("prefers sec-fetch-site, which page script cannot forge", () => {
    // A non-browser client controls Origin completely, so a browser-set
    // header beats it when present.
    expect(
      requireSameOrigin(
        req("POST", {
          "sec-fetch-site": "same-origin",
          origin: "https://evil.example",
        }),
        URL_,
      ),
    ).toBeNull();

    expect(
      requireSameOrigin(
        req("POST", {
          "sec-fetch-site": "cross-site",
          origin: "https://shop.example",
        }),
        URL_,
      )?.status,
    ).toBe(403);
  });

  it("treats sec-fetch-site: none (direct navigation) as safe", () => {
    expect(
      requireSameOrigin(req("POST", { "sec-fetch-site": "none" }), URL_),
    ).toBeNull();
  });

  it("rejects same-site — a sibling subdomain is not us", () => {
    expect(
      requireSameOrigin(req("POST", { "sec-fetch-site": "same-site" }), URL_)
        ?.status,
    ).toBe(403);
  });
});

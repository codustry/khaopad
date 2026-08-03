import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the product page's add-to-cart control.
 *
 * The page shipped with a footer reading "Cart + checkout ship in v3.2
 * … currently browse-only" and was still saying it at v3.8.1. Cart and
 * checkout had in fact been live for six minor versions — the routes
 * worked and the API accepted POSTs — but nothing on the product page
 * was ever wired to them. So the shop could not take an order at all.
 */
// decodeURIComponent: SvelteKit route dirs contain [brackets], which
// URL.pathname percent-encodes — the raw path would not resolve.
const PAGE = decodeURIComponent(
  new URL("./+page.svelte", import.meta.url).pathname,
);

describe("product page add to cart", () => {
  const page = readFileSync(PAGE, "utf8");

  it("makes no 'ships in vX.Y' promise", () => {
    expect(page).not.toMatch(/ship .{0,20}in v\d/i);
    expect(page).not.toMatch(/browse-only/i);
  });

  it("posts the selected variant to the cart API", () => {
    expect(page).toMatch(/\/api\/shop\/cart/);
    expect(page).toMatch(/variantId: selectedVariant\.id/);
  });

  it("surfaces the server's error rather than a generic message", () => {
    // Out-of-stock is actionable; "something went wrong" is not.
    expect(page).toMatch(/addError/);
  });

  it("disables the button while the request is in flight", () => {
    // Prevents double-adding on an impatient second click.
    expect(page).toMatch(/disabled=\{adding/);
  });

  it("offers a locale-aware route to the cart after a successful add", () => {
    // Was `href="/cart"` — the unprefixed funnel URL, which after #141
    // is only a redirect stub. Linking straight to the localized page
    // skips a 303 and keeps the visitor's locale without consulting
    // the cookie.
    expect(page).toMatch(
      /href=\{localePath\((?:data\.locale|locale), '\/cart'\)\}/,
    );
  });
});

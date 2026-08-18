import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The product detail page must show the product's own image.
 *
 * History: the load shipped `featuredImageUrl: null` behind a "ships when
 * the media picker lands" comment — the picker landed, the comment stayed,
 * and for several releases the ONLY images on a product page were the
 * related-products strip. Found by walking the deployed demo, not by any
 * check: listing cards resolved the same field fine, so everything stayed
 * green. These pins hold both halves of the wiring.
 */
// decodeURIComponent: [slug] percent-encodes in import.meta.url.
const here = (p: string) =>
  decodeURIComponent(new URL(p, import.meta.url).pathname);

describe("product detail — featured image wiring", () => {
  const page = readFileSync(here("./+page.svelte"), "utf8");
  const server = readFileSync(here("./+page.server.ts"), "utf8");

  it("renders the featured image when the product has one", () => {
    expect(page).toMatch(/\{#if product\.featuredMediaId\}/);
    expect(page).toMatch(
      /src=\{`\/api\/media\/\$\{product\.featuredMediaId\}`\}/,
    );
    // Meaningful alt — this is THE product image, not decoration.
    expect(page).toContain("alt={localization.title}");
  });

  it("feeds an absolute image URL into the Product JSON-LD", () => {
    // schema.org consumers resolve `image` with no page context, so the
    // origin must be baked in — a relative path here is silently useless.
    expect(server).toMatch(/featuredImageUrl: product\.featuredMediaId/);
    expect(server).toMatch(
      /`\$\{origin\}\/api\/media\/\$\{product\.featuredMediaId\}`/,
    );
    expect(server).not.toContain("featuredImageUrl: null,");
  });
});

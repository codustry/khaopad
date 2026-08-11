import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ⌘K content search pins (#160 C7).
 *
 * Structural tests over the palette source, in the style of
 * interaction.node.test.ts: they pin the decisions that are easy to
 * lose in a refactor and expensive to rediscover in production.
 */
const src = readFileSync(
  new URL("./CommandPalette.svelte", import.meta.url),
  "utf8",
);

describe("CommandPalette content search", () => {
  it("debounces the endpoint fetch at 250ms", () => {
    expect(src).toContain("SEARCH_DEBOUNCE_MS = 250");
    expect(src).toMatch(/setTimeout\([\s\S]*SEARCH_DEBOUNCE_MS\)/);
  });

  it("only fetches for queries of 2+ characters", () => {
    // Below 2 the endpoint returns nothing anyway; fetching would just
    // burn a request per keystroke.
    expect(src).toContain("SEARCH_MIN_CHARS = 2");
  });

  it("hits the admin search endpoint", () => {
    expect(src).toContain("/api/admin/search?q=");
    expect(src).toContain("encodeURIComponent");
  });

  it("drops stale responses instead of racing them", () => {
    // Two in-flight fetches resolving out of order must not leave the
    // older result on screen.
    expect(src).toMatch(/token !== searchToken/);
  });

  it("renders content hits BELOW the nav matches, under group headings", () => {
    // Nav first, content after — muscle memory for page jumps stays put.
    expect(src).toMatch(/\.\.\.results\.map[\s\S]*\.\.\.contentHits\.map/);
    expect(src).toContain("admin_palette_group_orders");
    expect(src).toContain("admin_palette_group_products");
    expect(src).toContain("admin_palette_group_articles");
  });

  it("gates content groups with the same role predicate as nav items", () => {
    // Orders is an admin+ route, products editor+ — identical to the
    // shop plugin's registerNavGroup roles. The endpoint enforces the
    // same server-side; this only prevents a broken-looking UI.
    expect(src).toMatch(/function roleAllows\(/);
    expect(src).toMatch(/ORDER_ROLES = \['super_admin', 'admin'\]/);
    expect(src).toMatch(/PRODUCT_ROLES = \['super_admin', 'admin', 'editor'\]/);
    expect(src).toContain("roleAllows(ORDER_ROLES)");
    expect(src).toContain("roleAllows(PRODUCT_ROLES)");
  });

  it("navigates with goto on select, without re-resolving hrefs", () => {
    expect(src).toMatch(
      /goto\(row\.kind === 'nav' \? row\.entry\.item\.href : row\.hit\.href\)/,
    );
  });

  it("stays out of the $lib/components/admin barrel", () => {
    // The palette imports sidebar-nav, whose plugin-registration cycle
    // must not ride along with every admin-barrel import. Also pinned
    // by design-system.node.test.ts; duplicated here because THIS
    // change is the one most likely to tempt someone to export it.
    const barrel = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(barrel).not.toMatch(/export .*CommandPalette/);
  });
});

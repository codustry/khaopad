import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards #125: editors were AUTHORIZED to edit registry entries but had
 * no navigable path to reach them. The sidebar entry and the index page
 * were admin-gated while the entry routes beneath them admitted editors
 * — so the registry was admin-only in practice, regardless of what the
 * route guards said. Permission and navigation must agree.
 */
const here = (p: string) => new URL(p, import.meta.url).pathname;
const index = readFileSync(here("./+page.server.ts"), "utf8");
const page = readFileSync(here("./+page.svelte"), "utf8");
const nav = readFileSync(
  here("../../../../lib/components/admin/sidebar-nav.ts"),
  "utf8",
);

describe("registry access (#125)", () => {
  it("the index admits editors", () => {
    // The load guard, not the actions: browsing is editor-level work.
    expect(index).toMatch(/hasRole\(locals\.user, "editor"\)/);
  });

  it("type-definition ACTIONS stay admin-gated", () => {
    // Defining a content type changes what the public API exposes — a
    // schema change. Opening the index to editors must not open these.
    const actions = index.slice(index.indexOf("export const actions"));
    const guards = actions.match(/hasRole\(locals\.user, "admin"\)/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2); // create + delete
  });

  it("the page hides type-definition UI from editors", () => {
    expect(index).toContain("canManageTypes");
    expect(page).toContain("data.canManageTypes");
  });

  it("the sidebar entry is visible to editors", () => {
    // The whole bug: routes admitted editors, but the only LINK to the
    // area did not.
    const entry = nav.match(
      /href: "\/admin\/content",[\s\S]*?roles: \[([^\]]*)\]/,
    );
    expect(entry).toBeTruthy();
    expect(entry![1]).toContain('"editor"');
  });

  it("entry routes still admit editors (the permission side of the pact)", () => {
    const collection = readFileSync(
      here("./[collection]/+page.server.ts"),
      "utf8",
    );
    expect(collection).toMatch(/hasRole\([^)]*"editor"\)/);
  });
});

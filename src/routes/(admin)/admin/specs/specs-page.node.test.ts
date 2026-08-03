import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Structural guards for the specs admin page (#130, definitions half).
 *
 * Same class of assertions as collections-page.node.test.ts: they cannot
 * prove the page looks right, but they prove the specific regressions
 * the admin design system exists to prevent — and that the write-side
 * guards match the repo's role model (editors browse, admins define).
 */
const PAGE = new URL("./+page.svelte", import.meta.url).pathname;
const SERVER = new URL("./+page.server.ts", import.meta.url).pathname;
const SIDEBAR = new URL(
  "../../../../lib/components/admin/sidebar-nav.ts",
  import.meta.url,
).pathname;

describe("specs admin page", () => {
  const page = readFileSync(PAGE, "utf8");
  const server = readFileSync(SERVER, "utf8");

  it("renders through the admin design system", () => {
    expect(page).toContain("PageShell");
    expect(page).toContain("PageHeader");
    expect(page).toContain("DataTable");
    // PageHeader owns the h1 — a hand-rolled one reintroduces the
    // two-competing-weights drift the design system ended.
    expect(page).not.toMatch(/<h1[\s>]/);
  });

  it("lets editors view but keeps definition actions admin-gated", () => {
    // Load admits editor+ (browse), mirroring /admin/content (#125).
    expect(server).toMatch(/hasRole\(locals\.user, "editor"\)/);
    // Every action re-checks admin server-side — hiding the forms via
    // `canManage` is presentation, not security.
    const actionGuards =
      server.match(/hasRole\(locals\.user, "admin"\)/g) ?? [];
    expect(actionGuards.length).toBeGreaterThanOrEqual(4);
  });

  it("hides management forms from editors via canManage", () => {
    expect(server).toContain("canManage");
    expect(page).toContain("data.canManage");
  });

  it("wires every service capability it claims", () => {
    for (const method of [
      "createAttribute",
      "deleteAttribute",
      "createFamily",
      "addAttributeToFamily",
      "listAttributes",
      "listFamilies",
      "familyAttributeList",
    ]) {
      expect(server).toContain(method);
    }
  });

  it("requires the key to be retyped before deleting an attribute", () => {
    // Same typed-confirm pattern as deleting a content type — the
    // service refuses in-use attributes, but an unused definition
    // shouldn't die to a stray click either.
    expect(server).toMatch(/confirm !== key/);
    expect(page).toMatch(/action="\?\/deleteAttribute"/);
    expect(page).toMatch(/name="confirm"/);
  });

  it("surfaces AttributeError messages rather than a generic failure", () => {
    expect(server).toContain("AttributeError");
    expect(server).toMatch(/fail\(4\d\d, \{ error/);
  });

  it("only renders conditional fields the service actually validates", () => {
    // measurement → unit family; select/multiselect → options. These are
    // the two conditional configs createAttribute accepts.
    expect(page).toContain("measureFamily");
    expect(page).toMatch(/name="options"/);
    // betterDirection / qualifiers exist in the schema but have no
    // createAttribute input — the form must not pretend otherwise.
    expect(page).not.toContain("betterDirection");
    expect(page).not.toContain("qualifier");
  });

  it("does not import CommandPalette (module-cycle guard)", () => {
    expect(page).not.toContain("CommandPalette");
  });
});

describe("specs sidebar entry", () => {
  const sidebar = readFileSync(SIDEBAR, "utf8");

  it("links /admin/specs and admits editors", () => {
    expect(sidebar).toContain('"/admin/specs"');
    const entry = sidebar.slice(sidebar.indexOf('"/admin/specs"'));
    const roles = entry.slice(0, entry.indexOf("},"));
    expect(roles).toContain('"editor"');
    expect(roles).toContain('"admin"');
  });
});

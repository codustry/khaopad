import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the extracted admin design system against the drift it was
 * created to end.
 *
 * The admin had 45 pages and no shared components, so every page
 * reinvented headers, padding, tables and buttons. The measurable
 * consequences were: two competing h1 weights, five padding scales, six
 * max-widths, and — the one that actually hurt users — 33 of 33 buttons
 * on the article editor with no focus ring, because 23 pages bypassed
 * the `Button` component that defines one correctly.
 *
 * These assertions are structural rather than visual. They cannot prove
 * the admin looks good; they prove the specific regressions that
 * produced the mess cannot silently return.
 */
const ADMIN_ROUTES = new URL("../../../routes/(admin)/admin", import.meta.url)
  .pathname;
const COMPONENTS = new URL(".", import.meta.url).pathname;

/** Pages that render outside the admin shell and own their full-bleed layout. */
const UNSHELLED = ["login", "signup", "invite"];

function adminPages(dir = ADMIN_ROUTES, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) adminPages(full, acc);
    else if (entry.name === "+page.svelte") acc.push(full);
  }
  return acc;
}

const pages = adminPages();
const shelled = pages.filter(
  (p) => !UNSHELLED.some((u) => p.includes(`/admin/${u}`)),
);
const read = (p: string) => readFileSync(p, "utf8");
const rel = (p: string) => p.slice(p.indexOf("/admin/"));

describe("admin design system", () => {
  it("finds the admin pages it claims to guard", () => {
    // A glob that silently matches nothing would make every assertion
    // below vacuously true.
    expect(pages.length).toBeGreaterThan(30);
    expect(shelled.length).toBeGreaterThan(30);
  });

  it("routes every page through PageShell", () => {
    const missing = shelled
      .filter((p) => !read(p).includes("PageShell"))
      .map(rel);
    expect(missing).toEqual([]);
  });

  it("no page hand-rolls its own <h1>", () => {
    // 41 pages did, in two competing weights. PageHeader settles it.
    const offenders = shelled.filter((p) => /<h1[\s>]/.test(read(p))).map(rel);
    expect(offenders).toEqual([]);
  });

  it("no page inlines bg-primary on a clickable instead of using <Button>", () => {
    // This is the focus-ring accessibility failure at its source: an
    // inline `bg-primary` link is a button that looks right and is
    // invisible to keyboard users.
    //
    // Scoped to <a> and <button> openings. `bg-primary` on a chart bar
    // or a progress fill is a legitimate use of the token — flagging
    // those would push authors to suppress the rule rather than fix it.
    const CLICKABLE_PRIMARY = /<(a|button)\b[^>]*class="[^"]*\bbg-primary\b/s;
    const offenders = shelled
      .filter((p) => CLICKABLE_PRIMARY.test(read(p)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("never clips a table with overflow-hidden", () => {
    // `overflow-hidden` on a table wrapper clips instead of scrolling on
    // mobile — the defect that had to be fixed in 13 files in v3.8.0
    // because no shared table component existed to fix it in once.
    const offenders = pages
      .filter((p) => {
        const src = read(p);
        return (
          src.includes("<table") && /overflow-hidden[^"]*">\s*<table/.test(src)
        );
      })
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("uses semantic color tokens so dark mode works", () => {
    // Literal light-mode colors don't invert: `bg-white` stays white on
    // a dark background, and text on it becomes unreadable. Paired
    // `dark:` variants are fine, so only unpaired literals are flagged.
    const BARE_LIGHT =
      /class="[^"]*\b(bg-white|bg-gray-50|bg-neutral-50|text-black)\b(?![^"]*\bdark:)/;
    const offenders = shelled.filter((p) => BARE_LIGHT.test(read(p))).map(rel);
    expect(offenders).toEqual([]);
  });
});

describe("barrel export cycle", () => {
  const barrel = readFileSync(join(COMPONENTS, "index.ts"), "utf8");

  it("does not re-export components that import the nav registry", () => {
    // CommandPalette imports `sidebar-nav`, which imports the plugin
    // registrations, whose module-eval `registerNavGroup()` calls run
    // during `sidebar-nav`'s own initialization.
    //
    // Re-exporting it here puts that chain behind every
    // `$lib/components/admin` import, so all 41 admin pages drag it in and
    // the cycle resolves with the function still undefined:
    //
    //   TypeError: registerNavGroup is not a function
    //
    // which 500s every admin route. Same failure class as the `let
    // _registry` TDZ crash reported downstream in #134. It is invisible to
    // `svelte-check` and to the production build — it only appears when a
    // request actually evaluates the graph.
    expect(barrel).not.toMatch(/export .*CommandPalette/);
  });

  it("names the components it does export", () => {
    // Guards the assertion above from passing because the barrel emptied.
    for (const name of [
      "PageShell",
      "PageHeader",
      "DataTable",
      "StatusBadge",
    ]) {
      expect(barrel).toContain(name);
    }
  });
});

describe("theme", () => {
  const themeSrc = read(join(COMPONENTS, "theme.svelte.ts"));
  const appHtml = readFileSync(
    new URL("../../../app.html", import.meta.url).pathname,
    "utf8",
  );

  it("applies the theme before first paint", () => {
    // Svelte state initialises after hydration — at least one paint too
    // late, so a dark-mode user would see a white flash on every load.
    expect(appHtml).toMatch(/<script nonce="%sveltekit\.nonce%">/);
    expect(appHtml).toContain("khaopad-theme");
    expect(appHtml).toContain("classList.add");
  });

  it("nonces the inline script", () => {
    // `csp.mode: "auto"` emits a nonce-based policy. An un-nonced inline
    // script is exactly what broke the downstream fork in #133.
    const scriptTags = appHtml.match(/<script(?![^>]*\bsrc=)[^>]*>/g) ?? [];
    for (const tag of scriptTags) {
      expect(tag).toContain("%sveltekit.nonce%");
    }
  });

  it("keeps the storage key in sync between the two implementations", () => {
    // The pre-paint script and the Svelte state read the same key. If
    // they diverge the symptom is a theme flash — cosmetic enough to
    // pass review, irritating enough to matter.
    const key = themeSrc.match(/THEME_KEY = "([^"]+)"/)?.[1];
    expect(key).toBeTruthy();
    expect(appHtml).toContain(key!);
  });

  it("treats system as live rather than sampled once", () => {
    // Resolving the OS preference a single time at startup would leave a
    // machine that flips to dark at sunset showing a light admin.
    expect(themeSrc).toContain("addEventListener");
    expect(themeSrc).toContain("prefers-color-scheme");
  });

  it("sets color-scheme so UA-rendered controls follow", () => {
    // Scrollbars, form controls and the caret ignore CSS classes.
    expect(themeSrc).toContain("colorScheme");
  });
});

describe("unsaved-changes guard", () => {
  const src = read(join(COMPONENTS, "dirty-state.svelte.ts"));

  it("guards client-side navigation as well as unload", () => {
    // `beforeunload` only fires on full unloads. In a SPA the user
    // leaves by clicking the sidebar, which only `beforeNavigate` sees —
    // covering just one leaves the common case unguarded.
    expect(src).toContain("beforeunload");
    expect(src).toContain("beforeNavigate");
  });

  it("stays quiet while a save is in flight", () => {
    // Otherwise the post-save redirect prompts the user to confirm
    // leaving a page they just successfully saved.
    expect(src).toMatch(/#saving/);
  });
});

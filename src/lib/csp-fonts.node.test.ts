import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The admin layout links the IBM Plex stylesheet from Google Fonts. CSP
 * must allow BOTH halves or the failure is silent: the <link> is blocked
 * by `style-src`, or the woff2 files are blocked by `font-src`, and the
 * admin falls back to system fonts with nothing on the page to show for
 * it — only a console entry nobody reads. Found on a deployed demo.
 *
 * Same class of bug as #173's dropped <link> tags: green tests, green
 * typecheck, wrong-looking page.
 */
describe("CSP allows the admin's webfont", () => {
  const config = readFileSync(join(process.cwd(), "svelte.config.js"), "utf8");
  const layout = readFileSync(
    join(process.cwd(), "src/routes/(admin)/admin/+layout.svelte"),
    "utf8",
  );

  it("still links the font (guard is pointless if the link goes away)", () => {
    expect(layout).toContain("fonts.googleapis.com/css2");
  });

  it("permits the stylesheet host in style-src", () => {
    const styleSrc = config.slice(
      config.indexOf('"style-src"'),
      config.indexOf("]", config.indexOf('"style-src"')),
    );
    expect(styleSrc).toContain("https://fonts.googleapis.com");
  });

  it("permits the woff2 host in font-src", () => {
    const fontSrc = config.slice(
      config.indexOf('"font-src"'),
      config.indexOf("]", config.indexOf('"font-src"')),
    );
    expect(fontSrc).toContain("https://fonts.gstatic.com");
  });
});

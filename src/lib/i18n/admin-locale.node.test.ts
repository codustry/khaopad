import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards admin locale resolution.
 *
 * The CMS was pinned to English no matter what. `bindingsHook` derived
 * locale ONLY from the first path segment, so for `/admin/...` it saw
 * "admin", found it wasn't a supported locale, and fell back to
 * DEFAULT_LOCALE.
 *
 * Meanwhile AdminLocaleToggle wrote a PARAGLIDE_LOCALE cookie and
 * reloaded — deliberately, because the admin is locale-prefix-free and
 * prefixing would turn /admin/articles into /th/admin/articles. But
 * nothing read that cookie, so the toggle was inert.
 */
const HOOKS = new URL("../../hooks.server.ts", import.meta.url).pathname;
const TOGGLE = new URL(
  "../components/admin/AdminLocaleToggle.svelte",
  import.meta.url,
).pathname;

describe("admin locale resolution", () => {
  const hooks = readFileSync(HOOKS, "utf8");
  const toggle = readFileSync(TOGGLE, "utf8");

  it("reads the locale cookie on the admin surface", () => {
    expect(hooks).toMatch(/surface === "admin"/);
    expect(hooks).toMatch(/cookies\.get\(paraglideRuntime\.cookieName\)/);
  });

  it("still derives www locale from the URL", () => {
    // The public site must keep /en/blog ↔ /th/blog working; that is
    // SEO-visible and shareable in a way a cookie is not.
    expect(hooks).toMatch(/localeFromPathname/);
  });

  it("validates the cookie against supported locales", () => {
    // A crafted cookie must not select an unsupported locale.
    expect(hooks).toMatch(/supportedLocales\.includes\(cookieLocale\)/);
  });

  it("resolves surface before locale", () => {
    // bindingsHook branches on locals.surface, so surfaceHook must run
    // first or the admin branch never fires.
    const order = hooks.slice(hooks.indexOf("sequence("));
    expect(order.indexOf("surfaceHook")).toBeLessThan(
      order.indexOf("bindingsHook"),
    );
  });

  it("keeps the toggle writing the cookie the hook reads", () => {
    // Both halves must agree on the cookie name, or the toggle silently
    // does nothing again.
    expect(toggle).toMatch(/cookieName/);
    expect(toggle).toMatch(/document\.cookie/);
  });
});

/**
 * Storefront chrome registry — Step 2 of the theme/engine split (#174).
 *
 * WHY A REGISTRY AND NOT PROPS
 *
 * The obvious design is snippet props on `(www)/+layout.svelte`:
 *
 *     let { children, data, header, footer } = $props();
 *
 * That does not work, and the reason is worth recording so nobody tries it
 * again. SvelteKit instantiates layout components itself and passes exactly
 * `data` and `children` — there is no parent to supply anything else. ESLint's
 * `svelte/valid-prop-names-in-kit-pages` catches it, which is how this was
 * found: the code typechecked, built, and rendered byte-identical output,
 * because the fallback branch was simply always taken. A seam that silently
 * never fires is worse than no seam.
 *
 * So the override is registered instead of passed. A deployment calls
 * `setChrome()` once at startup — the same shape the plugin system already
 * uses for nav groups and payment providers — and the layout reads whatever is
 * registered at render time.
 *
 * WHAT IS AND IS NOT OVERRIDABLE
 *
 * Header and footer only. SEO tags, the cookie banner, the analytics beacon
 * and the theme-token style stay in the layout body where a theme cannot drop
 * them: losing consent handling or canonical URLs to a chrome swap would be a
 * compliance and SEO failure that no test would catch.
 *
 * Commerce surfaces (cart, checkout, product, collection) are NOT chrome and
 * are deliberately not registrable here. They stay engine-owned so a pricing
 * or inventory fix reaches every deployment — see #174 for the full argument,
 * and note that Shopify reached the same conclusion the hard way when it
 * deprecated `checkout.liquid`.
 */
import type { Component } from "svelte";

export type ChromeNavItem = {
  id: string;
  href: string;
  label: string;
};

/**
 * Props the header component receives. Everything is pre-resolved by the
 * layout — a theme renders, it does not re-derive.
 *
 * Adding an optional field here is backwards-compatible. Removing or renaming
 * one breaks every registered theme and requires a major version bump of the
 * theme contract (#174 Step 7).
 */
export type SiteHeaderProps = {
  locale: string;
  siteName: string;
  logoMediaId: string | null;
  primaryNav: readonly ChromeNavItem[];
  hasCareers: boolean;
  cartItemCount: number;
  /** Locale-swapped version of the current URL, query string preserved. */
  alternateHref: string;
};

export type SiteFooterProps = {
  locale: string;
  footerNav: readonly ChromeNavItem[];
};

export type ChromeOverrides = {
  header?: Component<SiteHeaderProps>;
  footer?: Component<SiteFooterProps>;
};

/**
 * `var`, deliberately — not `let`. Identical reasoning to the nav registry in
 * `$lib/components/admin/sidebar-nav.ts`, which documents an outage this
 * caused twice: a bundler may hoist a deployment's `setChrome()` call above
 * this declaration, and with `let` that is a TDZ ReferenceError on every
 * route. `var` is hoisted and initialised to undefined, so an early call is
 * harmless. See that file for the full incident history.
 */
// eslint-disable-next-line no-var
var _chrome: ChromeOverrides | undefined;

/**
 * Register replacement chrome. Call once at module-load time from
 * `src/lib/plugins/registrations.ts` (or a module it imports) — that file is
 * imported by BOTH the server (via runtime.ts) and the storefront client
 * bundle (via (www)/+layout.svelte), which is what makes an override
 * consistent across SSR and hydration. Registering anywhere only the server
 * loads produces the worst failure available: SSR paints the custom chrome,
 * hydration finds an empty registry, and the page snaps to the default.
 *
 * Passing a partial object is fine and expected: override the header, keep
 * Khao Pad's footer, or vice versa.
 */
export function setChrome(overrides: ChromeOverrides): void {
  _chrome = { ..._chrome, ...overrides };
}

/** Read the registered overrides. Returns an empty object when none are set. */
export function getChrome(): ChromeOverrides {
  return _chrome ?? {};
}

/**
 * Test seam. Not for application code — registrations are meant to happen once
 * at startup and persist for the process lifetime.
 */
export function __resetChromeForTests(): void {
  _chrome = undefined;
}

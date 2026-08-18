<script lang="ts">
	import '../../app.css';
	// Side-effect import: runs every plugin's + deployment's module-load
	// registrations (setChrome, checkout slots) in the STOREFRONT CLIENT
	// bundle. Without it, registrations run only server-side: SSR renders a
	// deployment's custom chrome, hydration finds an empty registry, and the
	// header snaps back to the default — the exact "registrations that only
	// ran server-side" failure sidebar-nav.ts documents for the admin, now
	// on the public surface. Found by adversarial review before any
	// deployment hit it.
	import '$lib/plugins/registrations';
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale, getAlternateLocale, SUPPORTED_LOCALES } from '$lib/i18n';
	import { page } from '$app/state';
	import Seo from '$lib/components/seo/Seo.svelte';
	import CookieBanner from '$lib/components/consent/CookieBanner.svelte';
	import SiteHeader from '$lib/components/www/SiteHeader.svelte';
	import SiteFooter from '$lib/components/www/SiteFooter.svelte';
	import { getChrome } from '$lib/components/www/chrome';
	import type { SiteHeaderProps, SiteFooterProps } from '$lib/components/www/chrome';
	import type { PageSeo } from '$lib/seo';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	/**
	 * ─── Storefront chrome seam (#174 Step 2) ───────────────────
	 *
	 * Header and footer come from a REGISTRY, so a deployment replaces them
	 * with `setChrome()` instead of forking this file. Props were the obvious
	 * design and do NOT work: SvelteKit constructs layouts itself and passes
	 * only `data` and `children`. See `$lib/components/www/chrome.ts` — the
	 * fallback branch was simply always taken, and the seam silently never
	 * fired while every check stayed green.
	 *
	 * This file was the project's single worst merge conflict: 86 lines
	 * upstream against 585 in a real fork, diverging in opposite directions
	 * every release. Both versions were correct — upstream's as a demo, the
	 * fork's as a storefront — so no merge resolution was ever right. Taking
	 * upstream deleted the brand; taking the fork silently dropped upstream's
	 * new work (that is how the cart icon and the fixed language switcher went
	 * missing downstream for a release).
	 *
	 * Everything NOT overridable here is deliberate: SEO tags, the cookie
	 * banner, the analytics beacon, and the theme-token style all keep working
	 * whatever chrome a deployment supplies. A theme cannot accidentally drop
	 * consent handling or break canonical URLs.
	 *
	 * Chrome is deployment-owned; commerce is not. Cart, checkout, product and
	 * collection pages stay engine-owned so a pricing or inventory fix reaches
	 * every deployment — see #174 for why that line is drawn where it is.
	 */
	let { children, data }: { children: Snippet; data: LayoutData } = $props();

	// Read at render time so a deployment's startup registration is picked up
	// regardless of module evaluation order.
	const chrome = $derived(getChrome());
	const HeaderComponent = $derived(chrome.header ?? SiteHeader);
	const FooterComponent = $derived(chrome.footer ?? SiteFooter);

	// Each public +page.server.ts may return `seo: PageSeo`; the layout
	// reads it via $app/state and renders all SEO tags via <Seo />.
	const pageSeo = $derived((page.data.seo as PageSeo | undefined) ?? undefined);
	const seoDefaults = $derived({
		siteName: data.siteSettings?.siteName ?? m.site_name(),
		description: m.site_description(),
		image: undefined,
		twitter: undefined,
	});

	// ─── Design settings (v3.17 D6) ─────────────────────────────
	// themePrimaryColor overrides the --color-primary token via an
	// inline style on the layout root: SSR renders it into the first
	// HTML payload, so a re-branded store never flashes the default
	// theme. The value is validated server-side to strict #hex before
	// it can be stored, so interpolating it into a style attribute is
	// safe. Empty/undefined leaves the app.css token untouched.
	const themePrimaryColor = $derived(
		typeof data.siteSettings?.themePrimaryColor === 'string' &&
			/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(data.siteSettings.themePrimaryColor)
			? data.siteSettings.themePrimaryColor
			: null,
	);

	// ─── Theme tokens (#174 Step 5) ─────────────────────────────
	// The same seam as themePrimaryColor, widened: each operator-set token
	// maps onto the CSS custom property app.css already consumes, emitted
	// through the same SSR-first inline style so a re-branded store never
	// flashes the default look. Unset tokens emit NOTHING — the app.css
	// defaults rule. Every value is re-validated here (defense in depth,
	// like themePrimaryColor above): the settings action is the gate, but
	// the layout must not trust historical or hand-edited rows, because
	// these strings land inside a style attribute.
	const hexColor = (v: unknown): string | null =>
		typeof v === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(v) ? v : null;
	const themeBackgroundColor = $derived(hexColor(data.siteSettings?.themeBackgroundColor));
	const themeForegroundColor = $derived(hexColor(data.siteSettings?.themeForegroundColor));
	const themeAccentColor = $derived(hexColor(data.siteSettings?.themeAccentColor));
	// Strict CSS length only — the number+unit shape the settings action
	// enforces, nothing else.
	const themeRadius = $derived(
		typeof data.siteSettings?.themeRadius === 'string' &&
			/^\d+(?:\.\d+)?(?:px|rem|em)$/.test(data.siteSettings.themeRadius)
			? data.siteSettings.themeRadius
			: null,
	);
	// Conservative whitelist — letters, digits, spaces, commas, hyphens —
	// so no quote, semicolon, brace or url() can ever reach the style
	// attribute. Multi-word families work unquoted ("Playfair Display").
	const themeFontDisplay = $derived(
		typeof data.siteSettings?.themeFontDisplay === 'string' &&
			/^[A-Za-z0-9][A-Za-z0-9 ,-]{0,119}$/.test(data.siteSettings.themeFontDisplay.trim())
			? data.siteSettings.themeFontDisplay.trim()
			: null,
	);
	// One declaration per set token; undefined (no style attribute at all)
	// when nothing is set, so the SSR output for an unthemed store is
	// byte-identical to before this seam existed.
	const themeStyle = $derived.by(() => {
		const decls: string[] = [];
		if (themePrimaryColor) decls.push(`--color-primary: ${themePrimaryColor}`);
		if (themeBackgroundColor) decls.push(`--color-background: ${themeBackgroundColor}`);
		if (themeForegroundColor) decls.push(`--color-foreground: ${themeForegroundColor}`);
		if (themeAccentColor) decls.push(`--color-accent: ${themeAccentColor}`);
		if (themeRadius) decls.push(`--radius: ${themeRadius}`);
		if (themeFontDisplay) decls.push(`--font-display: ${themeFontDisplay}`);
		return decls.length > 0 ? decls.join('; ') : undefined;
	});
	// ─── Header cart badge ──────────────────────────────────────
	// Count comes from the layout load (session cart), so it is correct
	// on first paint and refreshes with the cart page's existing
	// invalidate('/api/shop/cart').
	const cartItemCount = $derived(
		typeof data.cartItemCount === 'number' ? data.cartItemCount : 0,
	);

	// ─── Language switcher ──────────────────────────────────────
	// Swapping the locale used to drop the visitor on '/', so a shopper
	// deep in filtered results lost their place on every switch. Slugs
	// are shared across locales, so the same path resolves in both —
	// swap only the leading locale segment and keep the query string.
	const alternateLocale = $derived(getAlternateLocale(toLocale(data.locale)));
	const alternateHref = $derived.by(() => {
		const segments = page.url.pathname.split('/').filter(Boolean);
		if (SUPPORTED_LOCALES.includes(segments[0] as (typeof SUPPORTED_LOCALES)[number])) {
			segments[0] = alternateLocale;
		} else {
			segments.unshift(alternateLocale);
		}
		return `/${segments.join('/')}${page.url.search}`;
	});

	const themeLogoMediaId = $derived(
		typeof data.siteSettings?.themeLogoMediaId === 'string' &&
			data.siteSettings.themeLogoMediaId
			? data.siteSettings.themeLogoMediaId
			: null,
	);

	// Resolved once, passed to whichever chrome renders. A registered override
	// gets exactly what the default gets — no privileged access, so the built-in
	// header is not a special case a theme has to reverse-engineer.
	const headerProps = $derived<SiteHeaderProps>({
		locale: data.locale,
		siteName: data.siteSettings?.siteName ?? m.site_name(),
		logoMediaId: themeLogoMediaId,
		primaryNav: data.nav.primary,
		hasCareers: data.hasCareers,
		cartItemCount,
		alternateHref,
	});
	const footerProps = $derived<SiteFooterProps>({
		locale: data.locale,
		footerNav: data.nav.footer,
	});
</script>

<Seo seo={pageSeo} defaults={seoDefaults} locale={toLocale(data.locale)} />

<!-- bg-background + text-foreground on the token root (not just body):
     custom-property overrides only reach descendants, so the background/
     foreground tokens must be CONSUMED at or below the element that sets
     them. With no tokens set these resolve to the same values body already
     paints — a visual no-op. Both classes are already in the emitted CSS
     (buttons, admin shell), so the inventory guard is unaffected. -->
<div
	class="min-h-screen flex flex-col bg-background text-foreground"
	style={themeStyle}
>
	<HeaderComponent {...headerProps} />

	<main class="flex-1">
		{@render children()}
	</main>

	<FooterComponent {...footerProps} />
</div>

<!--
	Cloudflare Web Analytics beacon (v1.8). Only loaded when:
	- the operator set a token in /admin/settings, AND
	- the visitor opted in to analytics via the cookie banner.
	The first-party D1 page-view counter runs regardless.
-->
{#if data.siteSettings?.cfaToken && data.consent?.analytics}
	<script
		defer
		src="https://static.cloudflareinsights.com/beacon.min.js"
		data-cf-beacon={`{"token": "${data.siteSettings.cfaToken}"}`}
	></script>
{/if}

<CookieBanner
	consent={data.consent}
	privacyHref={data.hasPrivacyPage
		? localePath(toLocale(data.locale), '/privacy-policy')
		: undefined}
/>

<script lang="ts">
	import '../../app.css';
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale, getAlternateLocale, SUPPORTED_LOCALES } from '$lib/i18n';
	import { page } from '$app/state';
	import Seo from '$lib/components/seo/Seo.svelte';
	import CookieBanner from '$lib/components/consent/CookieBanner.svelte';
	import HeaderSearch from '$lib/components/www/HeaderSearch.svelte';
	import { ShoppingCart, User } from 'lucide-svelte';
	import type { PageSeo } from '$lib/seo';
	import type { Snippet } from 'svelte';
	import type { LayoutData } from './$types';

	let { children, data }: { children: Snippet; data: LayoutData } = $props();

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
</script>

<Seo seo={pageSeo} defaults={seoDefaults} locale={toLocale(data.locale)} />

<div
	class="min-h-screen flex flex-col"
	style={themePrimaryColor ? `--color-primary: ${themePrimaryColor}` : undefined}
>
	<header class="border-b border-border">
		<div class="container mx-auto px-4 py-4 flex items-center justify-between">
			<a href="/" class="flex items-center gap-2 text-xl font-bold">
				{#if themeLogoMediaId}
					<img
						src={`/api/media/${themeLogoMediaId}`}
						alt=""
						class="h-8 w-auto"
						height="32"
					/>
				{/if}
				{data.siteSettings?.siteName ?? m.site_name()}</a
			>
			<nav class="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm">
				{#each data.nav.primary as item (item.id)}
					<a href={item.href} class="hover:text-primary">{item.label}</a>
				{/each}
				<a href={localePath(toLocale(data.locale), '/blog')} class="hover:text-primary">
					{m.nav_blog()}
				</a>
				<a href={localePath(toLocale(data.locale), '/products')} class="hover:text-primary">
					{m.nav_shop()}
				</a>
				{#if data.hasCareers}
					<a href={localePath(toLocale(data.locale), '/careers')} class="hover:text-primary">
						{m.careers_nav()}
					</a>
				{/if}
				<HeaderSearch locale={toLocale(data.locale)} />
				<a
					href={localePath(toLocale(data.locale), '/account')}
					class="hover:text-primary"
					aria-label={m.nav_account()}
					title={m.nav_account()}
				>
					<User class="h-5 w-5" aria-hidden="true" />
				</a>
				<!-- Persistent cart entry point. Before this, the only route to
				     the cart was a transient "View cart" link beside add-to-cart
				     that vanished on the next navigation. -->
				<a
					href={localePath(toLocale(data.locale), '/cart')}
					class="relative hover:text-primary"
					aria-label={cartItemCount === 0
						? m.nav_cart()
						: cartItemCount === 1
							? m.nav_cart_count_one()
							: m.nav_cart_count({ count: cartItemCount })}
					title={m.nav_cart()}
				>
					<ShoppingCart class="h-5 w-5" aria-hidden="true" />
					{#if cartItemCount > 0}
						<span
							class="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground tabular-nums"
							aria-hidden="true"
						>
							{cartItemCount > 99 ? '99+' : cartItemCount}
						</span>
					{/if}
				</a>
				<a
					href={alternateHref}
					data-sveltekit-reload
					class="px-2 py-1 border border-border rounded text-xs hover:bg-muted"
				>
					{m.lang_switch()}
				</a>
			</nav>
		</div>
	</header>

	<main class="flex-1">
		{@render children()}
	</main>

	<footer class="border-t border-border py-8 text-sm text-muted-foreground">
		<div class="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3">
			<p>{m.footer_copyright({ year: new Date().getFullYear().toString() })}</p>
			{#if data.nav.footer.length > 0}
				<nav class="flex flex-wrap gap-4">
					{#each data.nav.footer as item (item.id)}
						<a href={item.href} class="hover:text-foreground">{item.label}</a>
					{/each}
				</nav>
			{/if}
		</div>
	</footer>
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

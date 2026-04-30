<script lang="ts">
	import { page } from '$app/state';
	import { localePath, toLocale } from '$lib/i18n';
	import * as m from '$lib/paraglide/messages';

	// `page.error` carries the SvelteKit error message. Prefer that;
	// fall back to a generic copy. `page.status` is the HTTP code.
	const status = $derived(page.status);
	const isNotFound = $derived(status === 404);
	const locale = $derived(
		toLocale(((page.data as { locale?: string }).locale as string) ?? 'en'),
	);
	const title = $derived(
		isNotFound ? m.error_404_title() : m.error_5xx_title(),
	);
	const subtitle = $derived(
		isNotFound ? m.error_404_subtitle() : m.error_5xx_subtitle(),
	);
</script>

<!-- SEO is intentionally minimal — error pages should not be indexed. -->
<svelte:head>
	<title>{status} — {m.site_name()}</title>
	<meta name="robots" content="noindex,nofollow" />
</svelte:head>

<section class="mx-auto w-full max-w-2xl px-5 py-16 text-center sm:px-8 sm:py-24">
	<p
		class="font-display text-7xl font-bold leading-none tracking-tight text-primary sm:text-8xl"
	>
		{status}
	</p>
	<h1
		class="font-display mt-6 text-3xl font-bold leading-tight tracking-tight text-foreground sm:text-4xl"
	>
		{title}
	</h1>
	<p class="mt-4 text-base text-muted-foreground sm:text-lg">{subtitle}</p>

	<!--
		Search box (only on 404). The form posts back to /blog?q= so it
		flows through the v1.4 FTS path. Keeping it as a plain GET form
		means the page works without JS.
	-->
	{#if isNotFound}
		<form
			method="GET"
			action={localePath(locale, '/blog')}
			role="search"
			class="mx-auto mt-10 flex max-w-md gap-2"
		>
			<input
				type="search"
				name="q"
				placeholder={m.error_404_search_placeholder()}
				class="flex-1 rounded-full border-2 border-foreground bg-background px-5 py-2.5 text-sm shadow-[0_3px_0_0_oklch(0.145_0_0)] focus:outline-none focus:ring-2 focus:ring-primary"
				aria-label={m.error_404_search_placeholder()}
			/>
			<button
				type="submit"
				class="inline-flex items-center gap-2 rounded-full border-2 border-foreground bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-[0_3px_0_0_oklch(0.145_0_0)] transition-transform hover:-translate-y-0.5"
			>
				{m.error_404_search_cta()}
			</button>
		</form>
	{/if}

	<div class="mt-10 flex flex-wrap items-center justify-center gap-3">
		<a
			href={localePath(locale, '/')}
			class="inline-flex items-center gap-2 rounded-full border-2 border-foreground bg-background px-5 py-2.5 text-sm font-semibold text-foreground shadow-[0_3px_0_0_oklch(0.145_0_0)] transition-transform hover:-translate-y-0.5"
		>
			← {m.error_back_home()}
		</a>
		<a
			href={localePath(locale, '/blog')}
			class="inline-flex items-center gap-2 rounded-full border-2 border-foreground bg-background px-5 py-2.5 text-sm font-semibold text-foreground shadow-[0_3px_0_0_oklch(0.145_0_0)] transition-transform hover:-translate-y-0.5"
		>
			{m.nav_blog()}
		</a>
	</div>
</section>

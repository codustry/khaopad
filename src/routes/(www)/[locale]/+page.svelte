<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { toLocale } from '$lib/i18n';
	import { resolve } from '$app/paths';
	let { data } = $props();
	const locale = $derived.by(() => toLocale(data.locale));
</script>

<svelte:head>
	<title>{m.site_name()} — {m.site_description()}</title>
	<meta name="description" content="{m.site_name()} — {m.site_description()}" />
</svelte:head>

<section class="container mx-auto px-4 py-16 text-center">
	<h1 class="text-4xl font-bold mb-4">{m.site_name()}</h1>
	<p class="text-xl text-muted-foreground mb-8">
		{m.site_description()}
	</p>
	<div class="flex gap-4 justify-center">
		<a
			href={resolve('/(www)/[locale]/blog', { locale })}
			class="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90"
		>
			{m.nav_blog()}
		</a>
	</div>
</section>

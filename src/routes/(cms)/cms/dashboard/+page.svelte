<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	let { data } = $props();
</script>

<svelte:head>
	<title>{m.cms_dashboard()} — {m.cms_app_name()}</title>
</svelte:head>

<div>
	<h1 class="text-2xl font-bold mb-6">{m.cms_dashboard()}</h1>

	<div class="grid gap-4 md:grid-cols-3">
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">{m.cms_stat_articles()}</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.articles}</p>
		</div>
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">{m.cms_stat_published()}</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.published}</p>
		</div>
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">{m.cms_stat_media()}</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.media}</p>
		</div>
	</div>
</div>

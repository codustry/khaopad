<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Dashboard — Khao Pad CMS</title>
</svelte:head>

<div>
	<h1 class="text-2xl font-bold mb-6">Dashboard</h1>

	<div class="grid gap-4 md:grid-cols-3">
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">Articles</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.articles}</p>
		</div>
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">Published</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.published}</p>
		</div>
		<div class="border border-border rounded-lg p-6">
			<h3 class="text-sm font-medium text-muted-foreground">Media Files</h3>
			<p class="text-3xl font-bold mt-2">{data.stats.media}</p>
		</div>
	</div>
</div>

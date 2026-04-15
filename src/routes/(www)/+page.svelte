<script lang="ts">
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>Khao Pad — Modular CMS</title>
	<meta name="description" content="Khao Pad (ข้าวผัด) — A modular CMS for Cloudflare" />
</svelte:head>

<section class="container mx-auto px-4 py-16 text-center">
	<h1 class="text-4xl font-bold mb-4">ข้าวผัด</h1>
	<p class="text-xl text-muted-foreground mb-8">
		Khao Pad — Modular CMS for Cloudflare
	</p>
	<div class="flex gap-4 justify-center">
		<a
			href="/{data.locale}/blog"
			class="inline-flex items-center px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90"
		>
			Read Blog
		</a>
	</div>
</section>

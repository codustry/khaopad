<script lang="ts">
	import '../../app.css';
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<div class="min-h-screen flex flex-col">
	<header class="border-b border-border">
		<div class="container mx-auto px-4 py-4 flex items-center justify-between">
			<a href="/" class="text-xl font-bold">Khao Pad</a>
			<nav class="flex gap-4 text-sm">
				<a href="/th/blog" class="hover:text-primary">Blog</a>
			</nav>
		</div>
	</header>

	<main class="flex-1">
		{@render children()}
	</main>

	<footer class="border-t border-border py-8 text-center text-sm text-muted-foreground">
		<p>&copy; {new Date().getFullYear()} Khao Pad. Built with SvelteKit.</p>
	</footer>
</div>

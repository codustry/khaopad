<script lang="ts">
	import { ShoppingCart } from 'lucide-svelte';
</script>

<div class="max-w-2xl space-y-4 p-6">
	<header class="flex items-center gap-3">
		<ShoppingCart class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Orders</h1>
	</header>
	<div class="rounded-lg border border-dashed border-border p-8 text-center">
		<p class="text-sm text-muted-foreground">
			Cart / checkout / orders ship in v3.2 (<a
				href="https://github.com/codustry/khaopad/issues/57"
				class="underline"
				target="_blank"
				rel="noopener">#57</a
			>).
		</p>
	</div>
</div>

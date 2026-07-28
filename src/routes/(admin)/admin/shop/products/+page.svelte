<script lang="ts">
	import { Package } from 'lucide-svelte';
</script>

<div class="max-w-2xl space-y-4 p-6">
	<header class="flex items-center gap-3">
		<Package class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Products</h1>
	</header>
	<div class="rounded-lg border border-dashed border-border p-8 text-center">
		<p class="text-sm text-muted-foreground">
			Product catalog ships in v3.1 (<a
				href="https://github.com/codustry/khaopad/issues/56"
				class="underline"
				target="_blank"
				rel="noopener">#56</a
			>). This placeholder confirms the shop plugin's routes mount correctly
			under <code>/admin/shop/*</code>.
		</p>
	</div>
</div>

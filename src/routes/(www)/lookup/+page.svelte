<script lang="ts">
	import { enhance } from '$app/forms';
	import { Search } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<div class="mx-auto max-w-md px-6 py-10">
	<header class="mb-6 flex items-center gap-3">
		<Search class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">Look up your order</h1>
	</header>

	<form method="POST" use:enhance class="space-y-4">
		{#if form?.error}
			<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
				{form.error}
			</div>
		{/if}
		<div class="space-y-2">
			<Label for="orderNumber">Order number</Label>
			<Input
				id="orderNumber"
				name="orderNumber"
				placeholder="KHP-2026-00042"
				required
			/>
		</div>
		<div class="space-y-2">
			<Label for="email">Email used at checkout</Label>
			<Input id="email" name="email" type="email" required />
		</div>
		<Button type="submit" class="w-full">Find my order</Button>
	</form>
</div>

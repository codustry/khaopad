<script lang="ts">
	import { enhance } from '$app/forms';
	import { Search } from 'lucide-svelte';
	import { Button, Input, Label } from '$lib/components/ui';
	import * as m from '$lib/paraglide/messages';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	// The action returns codes, not prose, so errors localize with the page.
	const errorText = $derived(
		form?.errorCode === 'not_found'
			? m.shop_lookup_not_found()
			: form?.errorCode === 'required'
				? m.shop_lookup_required()
				: form?.errorCode
					? m.shop_err_network()
					: null,
	);
</script>

<svelte:head>
	<title>{m.shop_lookup_title()}</title>
	<meta name="robots" content="noindex, follow" />
</svelte:head>

<div class="mx-auto max-w-md px-6 py-10">
	<header class="mb-6 flex items-center gap-3">
		<Search class="h-6 w-6 text-muted-foreground" />
		<h1 class="text-2xl font-semibold">{m.shop_lookup_title()}</h1>
	</header>

	<form method="POST" use:enhance class="space-y-4">
		{#if errorText}
			<div class="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">
				{errorText}
			</div>
		{/if}
		<div class="space-y-2">
			<Label for="orderNumber">{m.shop_order_number()}</Label>
			<Input
				id="orderNumber"
				name="orderNumber"
				placeholder="KHP-2026-00042"
				required
			/>
		</div>
		<div class="space-y-2">
			<Label for="email">{m.shop_lookup_email()}</Label>
			<Input id="email" name="email" type="email" required />
		</div>
		<Button type="submit" class="w-full">{m.shop_find_order()}</Button>
	</form>
</div>

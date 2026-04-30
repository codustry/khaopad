<script lang="ts">
	import { enhance } from '$app/forms';
	import * as m from '$lib/paraglide/messages';
	import { slugify } from '$lib/utils';
	import type { FormField, FormRecord } from '$lib/server/content/types';

	type Props = {
		existing?: FormRecord | null;
		formState?: { error?: string } | null;
		action: string;
		submitLabel: string;
	};

	let { existing = null, formState = null, action, submitLabel }: Props = $props();

	let label = $state(existing?.label ?? '');
	let key = $state(existing?.key ?? '');
	let enabled = $state(existing?.enabled ?? true);
	let successEn = $state(existing?.successMessages.en ?? '');
	let successTh = $state(existing?.successMessages.th ?? '');
	let fields = $state<FormField[]>(
		existing?.fields ?? [
			{ name: 'name', kind: 'text', label: 'Your name', required: true },
			{ name: 'email', kind: 'email', label: 'Email', required: true },
			{ name: 'message', kind: 'textarea', label: 'Message', required: true, rows: 4 },
		],
	);

	let loading = $state(false);
	const derivedKey = $derived(slugify(key || label));

	function addField(kind: FormField['kind']) {
		// Find a free name. Field names live in form-data, so they need
		// to be valid HTML form field names; we keep them lowercase
		// alphanumeric + underscore.
		let n: string = kind;
		let i = 2;
		while (fields.some((f) => f.name === n)) {
			n = `${kind}_${i++}`;
		}
		let field: FormField;
		if (kind === 'checkbox') {
			field = { name: n, kind: 'checkbox', label: 'New checkbox' };
		} else if (kind === 'textarea') {
			field = { name: n, kind: 'textarea', label: 'New textarea', rows: 4 };
		} else if (kind === 'email') {
			field = { name: n, kind: 'email', label: 'New email' };
		} else {
			field = { name: n, kind: 'text', label: 'New text' };
		}
		fields = [...fields, field];
	}

	function removeField(idx: number) {
		fields = fields.filter((_, i) => i !== idx);
	}

	function moveField(idx: number, dir: -1 | 1) {
		const next = [...fields];
		const target = idx + dir;
		if (target < 0 || target >= next.length) return;
		[next[idx], next[target]] = [next[target], next[idx]];
		fields = next;
	}
</script>

<form
	method="POST"
	{action}
	class="space-y-6"
	use:enhance={() => {
		loading = true;
		return async ({ update }) => {
			await update();
			loading = false;
		};
	}}
>
	{#if formState?.error}
		<div class="bg-destructive/10 text-destructive text-sm p-3 rounded-md">
			{formState.error}
		</div>
	{/if}

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header><h2 class="font-semibold">{m.cms_forms_basics()}</h2></header>
		<div class="grid sm:grid-cols-2 gap-3">
			<label class="block">
				<span class="text-sm font-medium">{m.cms_forms_label()}</span>
				<input
					name="label"
					bind:value={label}
					required
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</label>
			<label class="block">
				<span class="text-sm font-medium">{m.cms_forms_key()}</span>
				<input
					name="key"
					bind:value={key}
					placeholder={derivedKey || 'contact'}
					required
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm font-mono"
				/>
				<span class="text-xs text-muted-foreground">
					{m.cms_forms_key_help({ usage: `/api/forms/${derivedKey || 'contact'}` })}
				</span>
			</label>
		</div>
		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="enabled" bind:checked={enabled} class="h-4 w-4" />
			{m.cms_forms_enabled_label()}
		</label>
	</section>

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header class="flex items-center justify-between">
			<h2 class="font-semibold">{m.cms_forms_fields()}</h2>
			<div class="flex flex-wrap gap-1.5">
				{#each ['text', 'email', 'textarea', 'checkbox'] as kind (kind)}
					<button
						type="button"
						onclick={() => addField(kind as FormField['kind'])}
						class="px-2 py-1 border border-border rounded-md text-xs hover:bg-muted"
					>
						+ {kind}
					</button>
				{/each}
			</div>
		</header>

		{#if fields.length === 0}
			<p class="text-sm text-muted-foreground">{m.cms_forms_fields_empty()}</p>
		{:else}
			<div class="space-y-3">
				{#each fields as field, i (i)}
					<div class="border border-border rounded-md p-3 space-y-2 bg-muted/10">
						<div class="flex items-center justify-between gap-2">
							<span class="text-xs uppercase tracking-wider text-muted-foreground">
								{field.kind}
							</span>
							<div class="flex items-center gap-1">
								<button
									type="button"
									disabled={i === 0}
									onclick={() => moveField(i, -1)}
									class="px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
								>
									↑
								</button>
								<button
									type="button"
									disabled={i === fields.length - 1}
									onclick={() => moveField(i, 1)}
									class="px-1.5 py-0.5 text-xs text-muted-foreground hover:text-foreground disabled:opacity-30"
								>
									↓
								</button>
								<button
									type="button"
									onclick={() => removeField(i)}
									class="px-1.5 py-0.5 text-xs text-destructive hover:underline"
								>
									{m.cms_delete()}
								</button>
							</div>
						</div>
						<div class="grid sm:grid-cols-2 gap-2">
							<label class="block">
								<span class="text-xs font-medium">{m.cms_forms_field_name()}</span>
								<input
									bind:value={field.name}
									required
									class="mt-0.5 w-full px-2 py-1.5 border border-input rounded-md bg-background text-sm font-mono"
								/>
							</label>
							<label class="block">
								<span class="text-xs font-medium">{m.cms_forms_field_label()}</span>
								<input
									bind:value={field.label}
									required
									class="mt-0.5 w-full px-2 py-1.5 border border-input rounded-md bg-background text-sm"
								/>
							</label>
						</div>
						<label class="flex items-center gap-2 text-xs">
							<input type="checkbox" bind:checked={field.required} class="h-3.5 w-3.5" />
							{m.cms_forms_field_required()}
						</label>
					</div>
				{/each}
			</div>
		{/if}

		<!-- Pass field definitions to the server as JSON in a hidden input. -->
		<input type="hidden" name="fields" value={JSON.stringify(fields)} />
	</section>

	<section class="border border-border rounded-lg p-4 space-y-4">
		<header><h2 class="font-semibold">{m.cms_forms_success_messages()}</h2></header>
		<p class="text-xs text-muted-foreground">{m.cms_forms_success_help()}</p>
		<div class="grid sm:grid-cols-2 gap-3">
			<label class="block">
				<span class="text-xs font-medium">EN</span>
				<input
					name="success_en"
					bind:value={successEn}
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</label>
			<label class="block">
				<span class="text-xs font-medium">TH</span>
				<input
					name="success_th"
					bind:value={successTh}
					class="mt-1 w-full px-3 py-2 border border-input rounded-md bg-background text-sm"
				/>
			</label>
		</div>
	</section>

	<div class="flex items-center justify-between">
		<a href="/cms/forms" class="text-sm text-muted-foreground hover:underline">
			← {m.cms_back_to_list()}
		</a>
		<button
			type="submit"
			disabled={loading}
			class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
		>
			{loading ? m.cms_saving() : submitLabel}
		</button>
	</div>
</form>

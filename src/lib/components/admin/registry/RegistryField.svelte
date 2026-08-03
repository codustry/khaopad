<script lang="ts">
	/**
	 * Renders ONE registry field as the right editor — Phase 4 (#68 §F).
	 *
	 * Driven entirely by the field's registry row, so a content type added
	 * by inserting rows gets a working form with no code change. Replaces
	 * the per-type hand-built forms.
	 */
	import { Input, Label } from '$lib/components/ui';
	import MarkdownEditor from '$lib/components/editor/MarkdownEditor.svelte';
	import RelationPicker from './RelationPicker.svelte';
	import { FIELD_EDITORS, fieldName, labelFor } from './field-map';
	import type { CollectionField } from '$lib/server/content/registry/schema';

	let {
		field,
		value = '',
		locale,
		uiLocale = 'en',
		relationChoices = [],
		relationTotal = 0,
	}: {
		field: CollectionField;
		value?: unknown;
		/** Set for localized fields — namespaces the input name per locale. */
		locale?: string;
		/** Which label translation to show in the admin chrome. */
		uiLocale?: string;
		/** Entry pick-list for relation/component fields. */
		relationChoices?: { id: string; label: string }[];
		/** Total matching entries server-side, for the truncation hint. */
		relationTotal?: number;
	} = $props();

	const spec = $derived(FIELD_EDITORS[field.type]);
	const name = $derived(fieldName(field.type, field.apiId, locale));
	const label = $derived(labelFor(field.labelsJson, field.apiId, uiLocale));
	const config = $derived.by(() => {
		if (!field.configJson) return {} as Record<string, unknown>;
		try {
			const parsed = JSON.parse(field.configJson);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {} as Record<string, unknown>;
		}
	});

	const enumOptions = $derived(
		Array.isArray(config.options) ? (config.options as string[]) : []
	);

	/**
	 * Relation values arrive as an array of ids; the form posts them as one
	 * comma-separated field so a single FormData entry carries order.
	 */
	const selectedIds = $derived(
		Array.isArray(value) ? (value as unknown[]).map(String) : []
	);

	const asText = $derived(
		value === null || value === undefined
			? ''
			: typeof value === 'object'
				? JSON.stringify(value, null, 2)
				: String(value)
	);
</script>

<div class="space-y-1.5">
	<Label for={name} class="text-xs font-medium">
		{label}
		{#if field.required}
			<span class="text-destructive" title="Required">*</span>
		{/if}
		{#if locale}
			<span class="ml-1 font-normal text-muted-foreground">({locale})</span>
		{/if}
	</Label>

	{#if spec.editor === 'richtext'}
		<MarkdownEditor {name} value={asText} />
	{:else if spec.editor === 'textarea' || spec.editor === 'json'}
		<textarea
			id={name}
			{name}
			rows={spec.editor === 'json' ? 6 : 3}
			class="w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-sm"
			value={asText}
		></textarea>
	{:else if spec.editor === 'checkbox'}
		<!-- Hidden companion so an unchecked box still posts a value —
		     otherwise "false" is indistinguishable from "not submitted",
		     and unchecking could never clear the field. -->
		<input type="hidden" {name} value="false" />
		<input
			id={name}
			type="checkbox"
			{name}
			value="true"
			checked={value === true || value === 'true'}
			class="h-4 w-4 rounded border-input"
		/>
	{:else if spec.editor === 'select'}
		<select
			id={name}
			{name}
			class="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
		>
			<option value="">— none —</option>
			{#each enumOptions as option (option)}
				<option value={option} selected={String(value) === option}>
					{option}
				</option>
			{/each}
		</select>
	{:else if spec.editor === 'relation' || spec.editor === 'component'}
		<RelationPicker
			{name}
			inputId={name}
			choices={relationChoices}
			value={selectedIds}
			multiple={config.cardinality !== 'one'}
			total={relationTotal}
		/>
	{:else if spec.editor === 'media'}
		<!-- Media is referenced by id; the existing picker lands in a
		     follow-up, so this accepts an id directly for now. -->
		<Input id={name} {name} value={asText} placeholder="media id" />
		<p class="text-xs text-muted-foreground">
			Media id. The library picker is not wired into registry forms yet.
		</p>
	{:else}
		<Input id={name} {name} type={spec.inputType ?? 'text'} value={asText} />
	{/if}

	{#if spec.hint}
		<p class="text-xs text-muted-foreground">{spec.hint}</p>
	{/if}
</div>

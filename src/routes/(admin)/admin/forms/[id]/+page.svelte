<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import * as m from '$lib/paraglide/messages';
	import { Button } from '$lib/components/ui';
	import { PageShell, PageHeader, StatusBadge } from '$lib/components/admin';
	import FormEditor from '../FormEditor.svelte';
	import type { FormRecord, FormSubmissionRecord } from '$lib/server/content/types';

	let {
		data,
		form,
	}: {
		data: { form: FormRecord; submissions: FormSubmissionRecord[] };
		form: { ok?: boolean; error?: string } | null;
	} = $props();

	function fmtTime(iso: string): string {
		const d = new Date(iso);
		if (Number.isNaN(d.getTime())) return iso;
		return d.toLocaleString();
	}
</script>

<svelte:head>
	<title>{m.cms_forms_edit()} — {m.cms_app_name()}</title>
</svelte:head>

<PageShell width="form">
	<PageHeader
		title={m.cms_forms_edit()}
		breadcrumbs={[
			{ label: m.cms_forms(), href: resolve('/(admin)/admin/forms') },
			{ label: data.form.label },
		]}
	>
		{#snippet actions()}
			<form
				method="POST"
				action="?/delete"
				use:enhance={({ cancel }) => {
					if (!confirm(m.cms_delete_confirm())) {
						cancel();
						return;
					}
					return async ({ update }) => update();
				}}
			>
				<Button type="submit" variant="destructive" size="sm">
					{m.cms_delete()}
				</Button>
			</form>
		{/snippet}
	</PageHeader>

	<FormEditor
		existing={data.form}
		formState={form}
		action="?/save"
		submitLabel={m.cms_save()}
	/>

	<section class="mt-10 space-y-3">
		<header class="flex items-center justify-between flex-wrap gap-2">
			<h2 class="text-lg font-semibold">
				{m.cms_forms_submissions()}
				<span class="text-sm font-normal text-muted-foreground ml-2">
					({data.submissions.length})
				</span>
			</h2>
			<p class="text-xs text-muted-foreground font-mono">
				/api/forms/{data.form.key}
			</p>
		</header>

		{#if data.submissions.length === 0}
			<div class="border border-dashed border-border rounded-lg p-8 text-center">
				<p class="text-sm text-muted-foreground">{m.cms_forms_submissions_empty()}</p>
			</div>
		{:else}
			<div class="space-y-2">
				{#each data.submissions as s (s.id)}
					<details class="border border-border rounded-md overflow-hidden">
						<summary class="flex items-center gap-3 px-4 py-2.5 cursor-pointer bg-muted/20 hover:bg-muted/40">
							<StatusBadge
								status={s.status}
								tone={s.status === 'new'
									? 'info'
									: s.status === 'spam'
										? 'danger'
										: 'neutral'}
							/>
							<span class="text-xs text-muted-foreground tabular-nums">
								{fmtTime(s.submittedAt)}
							</span>
							<span class="text-sm truncate flex-1 min-w-0">
								{Object.entries(s.data)
									.slice(0, 2)
									.map(([k, v]) => `${k}: ${v}`)
									.join(' · ')}
							</span>
						</summary>
						<div class="p-4 space-y-3">
							<dl class="grid sm:grid-cols-[120px_1fr] gap-x-3 gap-y-1.5 text-sm">
								{#each Object.entries(s.data) as [k, v] (k)}
									<dt class="text-muted-foreground font-mono text-xs">{k}</dt>
									<dd class="break-words">{v || '—'}</dd>
								{/each}
							</dl>
							<div class="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
								{#each ['new', 'read', 'spam', 'archived'] as status (status)}
									{#if s.status !== status}
										<form method="POST" action="?/setSubmissionStatus" use:enhance>
											<input type="hidden" name="submission_id" value={s.id} />
											<input type="hidden" name="status" value={status} />
											<Button type="submit" variant="outline" size="sm" class="capitalize">
												Mark {status}
											</Button>
										</form>
									{/if}
								{/each}
								<form
									method="POST"
									action="?/deleteSubmission"
									use:enhance={({ cancel }) => {
										if (!confirm(m.cms_delete_confirm())) {
											cancel();
											return;
										}
										return async ({ update }) => update();
									}}
									class="ml-auto"
								>
									<input type="hidden" name="submission_id" value={s.id} />
									<Button
										type="submit"
										variant="outline"
										size="sm"
										class="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
									>
										{m.cms_delete()}
									</Button>
								</form>
							</div>
						</div>
					</details>
				{/each}
			</div>
		{/if}
	</section>
</PageShell>

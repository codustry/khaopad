<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import * as m from '$lib/paraglide/messages';
	import type { ConsentRecord } from '$lib/consent';

	let {
		consent,
		privacyHref,
	}: { consent: ConsentRecord; privacyHref: string } = $props();

	let saving = $state(false);
	let detailsOpen = $state(false);
	let acceptAnalytics = $state(consent.analytics);
	let acceptMarketing = $state(consent.marketing);

	const undecided = $derived(!consent.ts);

	async function save(verdict: 'all' | 'none' | 'custom') {
		saving = true;
		try {
			const body = new FormData();
			if (verdict === 'all') {
				body.append('analytics', '1');
				body.append('marketing', '1');
			} else if (verdict === 'custom') {
				if (acceptAnalytics) body.append('analytics', '1');
				if (acceptMarketing) body.append('marketing', '1');
			}
			await fetch('/api/consent', { method: 'POST', body });
			await invalidateAll();
		} finally {
			saving = false;
		}
	}
</script>

{#if undecided}
	<div
		class="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 backdrop-blur-sm shadow-lg"
		role="dialog"
		aria-live="polite"
		aria-label={m.cookie_banner_title()}
	>
		<div class="container mx-auto px-4 py-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
			<div class="flex-1 text-sm text-muted-foreground">
				<p class="font-medium text-foreground mb-1">{m.cookie_banner_title()}</p>
				<p>
					{m.cookie_banner_body()}
					<a href={privacyHref} class="underline hover:text-foreground">{m.cookie_banner_learn_more()}</a>
				</p>
				{#if detailsOpen}
					<div class="mt-3 space-y-2 border border-border rounded-md p-3 bg-muted/30">
						<label class="flex items-start gap-2 text-xs">
							<input type="checkbox" disabled checked class="mt-0.5" />
							<span>
								<strong>{m.cookie_cat_functional()}</strong> — {m.cookie_cat_functional_help()}
							</span>
						</label>
						<label class="flex items-start gap-2 text-xs">
							<input type="checkbox" bind:checked={acceptAnalytics} class="mt-0.5" />
							<span>
								<strong>{m.cookie_cat_analytics()}</strong> — {m.cookie_cat_analytics_help()}
							</span>
						</label>
						<label class="flex items-start gap-2 text-xs">
							<input type="checkbox" bind:checked={acceptMarketing} class="mt-0.5" />
							<span>
								<strong>{m.cookie_cat_marketing()}</strong> — {m.cookie_cat_marketing_help()}
							</span>
						</label>
					</div>
				{/if}
			</div>
			<div class="flex flex-col sm:flex-row gap-2 shrink-0">
				{#if detailsOpen}
					<button
						type="button"
						disabled={saving}
						onclick={() => save('custom')}
						class="px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
					>
						{m.cookie_save_choices()}
					</button>
				{:else}
					<button
						type="button"
						onclick={() => (detailsOpen = true)}
						class="px-3 py-2 border border-border rounded-md text-sm hover:bg-muted"
					>
						{m.cookie_customize()}
					</button>
				{/if}
				<button
					type="button"
					disabled={saving}
					onclick={() => save('none')}
					class="px-3 py-2 border border-border rounded-md text-sm hover:bg-muted disabled:opacity-50"
				>
					{m.cookie_reject()}
				</button>
				<button
					type="button"
					disabled={saving}
					onclick={() => save('all')}
					class="px-3 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90 disabled:opacity-50"
				>
					{m.cookie_accept_all()}
				</button>
			</div>
		</div>
	</div>
{/if}

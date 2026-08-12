<script lang="ts">
	import * as m from '$lib/paraglide/messages';
	import { localePath, toLocale } from '$lib/i18n';
	import { categoryLabel, humanizeEmploymentType } from '$plugins/careers/feed';
	import type { CareersJob } from '$plugins/careers/feed';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const locale = $derived(toLocale(data.locale));
	const basePath = $derived(localePath(locale, '/careers'));

	/**
	 * Feed text is rendered as TEXT throughout — no `{@html}` anywhere
	 * in this component. The upstream ATS is third-party and its
	 * strings are untrusted; Svelte's default escaping is the whole
	 * XSS defence and it must not be opted out of here. `applyUrl` is
	 * already scheme-checked to http(s) in `feed.ts` before it reaches
	 * the href below.
	 */

	function categoryHref(slug: string | null): string {
		return slug ? `${basePath}?category=${encodeURIComponent(slug)}` : basePath;
	}

	/** "฿60,000 – ฿90,000" / "From ฿60,000". Only called when salary exists. */
	function salaryLabel(job: CareersJob): string | null {
		const salary = job.salary;
		if (!salary) return null;
		const fmt = (n: number) =>
			new Intl.NumberFormat(locale === 'th' ? 'th-TH' : 'en-US', {
				style: 'currency',
				currency: salary.currency,
				maximumFractionDigits: 0
			}).format(n);
		if (salary.min !== null && salary.max !== null) {
			return salary.min === salary.max ? fmt(salary.min) : `${fmt(salary.min)} – ${fmt(salary.max)}`;
		}
		if (salary.min !== null) return m.careers_salary_from({ amount: fmt(salary.min) });
		if (salary.max !== null) return m.careers_salary_up_to({ amount: fmt(salary.max) });
		return null;
	}

	function postedLabel(iso: string | null): string | null {
		if (!iso) return null;
		const ms = Date.parse(iso);
		if (!Number.isFinite(ms)) return null;
		return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH' : 'en-US', {
			year: 'numeric',
			month: 'short',
			day: 'numeric'
		}).format(new Date(ms));
	}
</script>

<!-- SEO (canonical, hreflang, JobPosting JSON-LD) is rendered by the layout via page.data.seo. -->

<section class="container mx-auto px-4 py-12">
	<header class="mb-8 max-w-2xl">
		<h1 class="text-3xl font-bold">{m.careers_heading()}</h1>
		<p class="mt-2 text-muted-foreground">
			{m.careers_intro({ company: data.organizationName })}
		</p>
	</header>

	{#if data.categories.length > 0}
		<nav class="mb-8 flex flex-wrap items-center gap-2" aria-label={m.careers_filter_by_category()}>
			<a
				href={basePath}
				aria-current={data.activeCategory === null ? 'page' : undefined}
				class="inline-flex items-center rounded-full border px-3 py-1 text-xs transition-colors {data.activeCategory ===
				null
					? 'border-primary bg-primary text-primary-foreground'
					: 'border-border bg-muted/40 hover:bg-muted'}"
			>
				{m.careers_all_departments()}
			</a>
			{#each data.categories as category (category.slug)}
				<a
					href={categoryHref(category.slug)}
					aria-current={data.activeCategory === category.slug ? 'page' : undefined}
					class="inline-flex items-center rounded-full border px-3 py-1 text-xs transition-colors {data.activeCategory ===
					category.slug
						? 'border-primary bg-primary text-primary-foreground'
						: 'border-border bg-muted/40 hover:bg-muted'}"
				>
					{categoryLabel(category, locale)}
				</a>
			{/each}
		</nav>
	{/if}

	{#if data.jobs.length === 0}
		<!--
			Empty state, not an error page. This renders identically whether
			there are genuinely no openings or the ATS is unreachable — the
			page stays 200, indexable and linkable either way.
		-->
		<div class="rounded-lg border border-border py-16 text-center">
			<p class="text-lg font-medium">{m.careers_empty_heading()}</p>
			<p class="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
				{m.careers_empty_body()}
			</p>
			{#if data.activeCategory}
				<a href={basePath} class="mt-4 inline-block text-sm text-primary hover:underline">
					{m.careers_view_all_openings()}
				</a>
			{/if}
		</div>
	{:else}
		<p class="mb-4 text-sm text-muted-foreground">
			{m.careers_open_positions_count({ count: String(data.jobs.length) })}
		</p>

		<ul class="flex flex-col gap-4">
			{#each data.jobs as job (job.id)}
				{@const salary = salaryLabel(job)}
				{@const posted = postedLabel(job.publishedAt)}
				{@const employment = humanizeEmploymentType(job.employmentType)}
				<li
					class="rounded-lg border border-border p-5 transition-colors hover:border-primary/50"
				>
					<div class="flex flex-wrap items-start justify-between gap-4">
						<div class="min-w-0">
							<h2 class="text-lg font-semibold">{job.title}</h2>

							<div
								class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground"
							>
								{#if job.department}
									<span>{job.department}</span>
								{/if}
								{#if job.location}
									<span>{job.location}</span>
								{/if}
								{#if employment}
									<span>{employment}</span>
								{/if}
								{#if salary}
									<span class="font-medium text-foreground">{salary}</span>
								{/if}
							</div>

							{#if job.category || posted}
								<div class="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
									{#if job.category}
										<span class="rounded-full bg-muted px-2 py-0.5">
											{categoryLabel(job.category, locale)}
										</span>
									{/if}
									{#if posted}
										<span>{m.careers_posted_on({ date: posted })}</span>
									{/if}
								</div>
							{/if}
						</div>

						<!--
							Links out to the ATS-hosted application wizard. External
							destination, so rel="noopener" — and target=_blank keeps the
							marketing site open behind the multi-step form.
						-->
						<a
							href={job.applyUrl}
							target="_blank"
							rel="noopener noreferrer"
							class="inline-flex shrink-0 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
						>
							{m.careers_apply()}
						</a>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</section>

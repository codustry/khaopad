<script lang="ts">
	/**
	 * Fires `article_read` when the user has spent ≥30s on the article
	 * AND scrolled past 50% of the content. Fires exactly once per
	 * mount. Uses `visibilitychange` + `pagehide` so the beacon flushes
	 * on tab-close (not just on scroll-past — many readers scan the
	 * top, dwell, then leave without scrolling further).
	 *
	 * Drop into any article page:
	 *   <ArticleReadTracker articleId={data.article.id} />
	 */
	import { onMount } from 'svelte';
	import { track } from './track';

	let { articleId }: { articleId: string } = $props();

	const MIN_DWELL_MS = 30_000;
	const MIN_SCROLL_PCT = 50;

	let fired = false;
	let mountedAt = 0;
	let maxScrollPct = 0;

	function computeScrollPct(): number {
		if (typeof document === 'undefined') return 0;
		const doc = document.documentElement;
		const viewport = window.innerHeight;
		const total = doc.scrollHeight - viewport;
		if (total <= 0) return 100; // single-viewport article — fully visible
		return Math.min(100, Math.round(((doc.scrollTop || 0) / total) * 100));
	}

	function tryFire(reason: 'unload' | 'threshold') {
		if (fired) return;
		const dwellMs = Date.now() - mountedAt;
		if (reason === 'unload') {
			// On unload, fire if we hit the thresholds — beacon is our
			// only chance to record this session.
			if (dwellMs >= MIN_DWELL_MS && maxScrollPct >= MIN_SCROLL_PCT) {
				fired = true;
				track('article_read', {
					articleId,
					readTimeMs: dwellMs,
					scrollPct: maxScrollPct,
				});
			}
			return;
		}
		// threshold fire during session — same guards.
		if (dwellMs >= MIN_DWELL_MS && maxScrollPct >= MIN_SCROLL_PCT) {
			fired = true;
			track('article_read', {
				articleId,
				readTimeMs: dwellMs,
				scrollPct: maxScrollPct,
			});
		}
	}

	onMount(() => {
		mountedAt = Date.now();
		const onScroll = () => {
			maxScrollPct = Math.max(maxScrollPct, computeScrollPct());
			// Check the threshold as scroll happens — a fast scroll to the
			// bottom + dwell would fire quicker without waiting for unload.
			if (Date.now() - mountedAt >= MIN_DWELL_MS) tryFire('threshold');
		};
		const onVis = () => {
			if (document.visibilityState === 'hidden') tryFire('unload');
		};
		const onHide = () => tryFire('unload');
		window.addEventListener('scroll', onScroll, { passive: true });
		document.addEventListener('visibilitychange', onVis);
		window.addEventListener('pagehide', onHide);
		// Initial scroll capture (some UAs won't fire scroll immediately).
		maxScrollPct = computeScrollPct();
		return () => {
			window.removeEventListener('scroll', onScroll);
			document.removeEventListener('visibilitychange', onVis);
			window.removeEventListener('pagehide', onHide);
			// One last shot on unmount (SPA navigations, not full unload).
			tryFire('unload');
		};
	});
</script>

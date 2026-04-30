<script lang="ts">
	/**
	 * Responsive `<img>` (v1.9). Uses Cloudflare's URL-based image
	 * transformations: `/cdn-cgi/image/width=W,format=auto/<src>` is
	 * intercepted by the zone if Cloudflare Images is enabled, and
	 * passed through unchanged if it isn't — so this falls back to
	 * the raw R2 URL safely on any deployment.
	 *
	 * Usage:
	 *   <ResponsiveImage src="/api/media/abc123" alt="Khao pad" />
	 *
	 * The component emits `srcset` with three widths (640, 1024, 1920)
	 * and a `sizes` attribute that defaults to "100vw on phones, 768px
	 * on tablets, 960px on desktop" — override per-instance when the
	 * image lives in a narrow column.
	 */
	type Props = {
		src: string;
		alt: string;
		/** CSS sizes attribute. Default targets the article reading column. */
		sizes?: string;
		class?: string;
		/** Aspect ratio class (e.g. `aspect-[16/9]`). */
		aspect?: string;
		loading?: 'lazy' | 'eager';
		decoding?: 'async' | 'sync' | 'auto';
	};

	let {
		src,
		alt,
		sizes = '(max-width: 640px) 100vw, (max-width: 1024px) 768px, 960px',
		class: className = '',
		aspect = '',
		loading = 'lazy',
		decoding = 'async',
	}: Props = $props();

	const widths = [640, 1024, 1920] as const;

	/** Build a `/cdn-cgi/image/width=W,format=auto/<src>` URL. */
	function transformed(source: string, width: number): string {
		// Only rewrite same-origin sources. Absolute URLs (e.g. an
		// already-CDN-hosted asset) get passed through verbatim.
		if (source.startsWith('http://') || source.startsWith('https://')) {
			return source;
		}
		const normalized = source.startsWith('/') ? source : `/${source}`;
		return `/cdn-cgi/image/width=${width},format=auto,quality=85${normalized}`;
	}

	const srcset = $derived(
		widths.map((w) => `${transformed(src, w)} ${w}w`).join(', '),
	);
	// Largest width as the fallback `src` so older browsers still get
	// something reasonable.
	const fallback = $derived(transformed(src, 1920));
</script>

<img
	src={fallback}
	{srcset}
	{sizes}
	{alt}
	{loading}
	{decoding}
	class={`${aspect} ${className}`.trim()}
/>

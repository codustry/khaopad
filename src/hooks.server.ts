import type { Handle } from '@sveltejs/kit';
import { sequence } from '@sveltejs/kit/hooks';
import { createAuth } from '$lib/server/auth';
import { createContentProvider } from '$lib/server/content';
import { R2MediaService } from '$lib/server/media';
import type { ContentMode } from '$lib/server/content';

/**
 * Subdomain detection hook.
 * Routes requests to (www) or (cms) route groups based on hostname.
 */
const subdomainHook: Handle = async ({ event, resolve }) => {
	const host = event.request.headers.get('host') ?? '';

	// Determine subdomain
	if (host.startsWith('cms.') || host.includes('cms.')) {
		event.locals.subdomain = 'cms';
	} else {
		event.locals.subdomain = 'www';
	}

	// Block CMS routes from www and vice versa
	const path = event.url.pathname;
	if (event.locals.subdomain === 'www' && isCmsRoute(path)) {
		return new Response('Not Found', { status: 404 });
	}
	if (event.locals.subdomain === 'cms' && isWwwOnlyRoute(path)) {
		return new Response('Not Found', { status: 404 });
	}

	return resolve(event);
};

/**
 * Platform bindings hook.
 * Initializes content provider, media service, and locale from Cloudflare bindings.
 */
const bindingsHook: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) {
		// Local dev without wrangler — provide defaults
		event.locals.locale = 'th';
		return resolve(event);
	}

	// Content provider
	const contentMode = (env.CONTENT_MODE ?? 'd1') as ContentMode;
	event.locals.content = createContentProvider(contentMode, env);

	// Media service
	const mediaBaseUrl = event.locals.subdomain === 'cms'
		? `${env.CMS_SITE_URL}/api/media`
		: `${env.PUBLIC_SITE_URL}/api/media`;
	event.locals.media = new R2MediaService(env.DB, env.MEDIA_BUCKET, mediaBaseUrl);

	// Locale detection (from URL path or Accept-Language)
	const supportedLocales = (env.SUPPORTED_LOCALES ?? 'th,en').split(',');
	const defaultLocale = env.DEFAULT_LOCALE ?? 'th';
	const pathLocale = event.url.pathname.split('/')[1];
	event.locals.locale = supportedLocales.includes(pathLocale) ? pathLocale : defaultLocale;

	return resolve(event, {
		transformPageChunk: ({ html }) => html.replace('%lang%', event.locals.locale),
	});
};

/**
 * Auth hook.
 * Resolves the current user session from Better Auth cookies.
 */
const authHook: Handle = async ({ event, resolve }) => {
	const env = event.platform?.env;
	if (!env) {
		event.locals.user = null;
		event.locals.session = null;
		return resolve(event);
	}

	const auth = createAuth(env.DB, {
		BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET,
		BETTER_AUTH_URL: env.BETTER_AUTH_URL,
	});

	// Resolve session from request cookies
	const session = await auth.api.getSession({
		headers: event.request.headers,
	});

	if (session) {
		event.locals.user = session.user as App.Locals['user'];
		event.locals.session = session.session as App.Locals['session'];
	} else {
		event.locals.user = null;
		event.locals.session = null;
	}

	return resolve(event);
};

// ─── Route classification helpers ────────────────────────

/** CMS-only route paths (under (cms) group) */
function isCmsRoute(path: string): boolean {
	const cmsRoutes = ['/dashboard', '/articles', '/media', '/categories', '/users', '/settings'];
	return cmsRoutes.some((r) => path.startsWith(r)) || path === '/login';
}

/** Routes that should only be accessible from www */
function isWwwOnlyRoute(path: string): boolean {
	// Blog and locale-prefixed routes are www-only
	return /^\/(th|en)\//.test(path);
}

export const handle = sequence(subdomainHook, bindingsHook, authHook);

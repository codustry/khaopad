import type { Locale } from '$lib/server/content/types';

export const SUPPORTED_LOCALES: Locale[] = ['th', 'en'];
export const DEFAULT_LOCALE: Locale = 'th';

export const LOCALE_NAMES: Record<Locale, string> = {
	th: 'ไทย',
	en: 'English',
};

/** Get the other locale (for language switcher) */
export function getAlternateLocale(current: Locale): Locale {
	return current === 'th' ? 'en' : 'th';
}

/** Build a localized path */
export function localePath(locale: Locale, path: string): string {
	return `/${locale}${path.startsWith('/') ? path : `/${path}`}`;
}

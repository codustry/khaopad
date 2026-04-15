import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes (shadcn/ui helper) */
export function cn(...inputs: ClassValue[]) {
	return twMerge(clsx(inputs));
}

/** Format a date string for display */
export function formatDate(date: string, locale: string = 'th'): string {
	return new Date(date).toLocaleDateString(locale === 'th' ? 'th-TH' : 'en-US', {
		year: 'numeric',
		month: 'long',
		day: 'numeric',
	});
}

/** Generate a URL-safe slug from text */
export function slugify(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\w\s-]/g, '')
		.replace(/[\s_]+/g, '-')
		.replace(/^-+|-+$/g, '');
}

/** Truncate text to a max length */
export function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return text.slice(0, maxLength).trimEnd() + '...';
}

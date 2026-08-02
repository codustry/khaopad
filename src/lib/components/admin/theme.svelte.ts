/**
 * Theme state for the admin shell.
 *
 * ## Why the FOUC guard lives in app.html, not here
 *
 * Svelte state initialises after hydration, which is at least one paint
 * too late — a dark-mode user would see a white flash on every full page
 * load. So the *applying* of the class happens in a blocking inline
 * script in `app.html`; this module owns the state afterwards and keeps
 * localStorage in sync. Both read the same key, `THEME_KEY`.
 *
 * ## Three states, not two
 *
 * `system` is the default and is not the same as resolving system
 * preference once at startup: it keeps following the OS, so a user whose
 * machine flips to dark at sunset gets a dark admin without touching a
 * setting. Only an explicit light/dark choice pins it.
 */
import { browser } from "$app/environment";

export const THEME_KEY = "khaopad-theme";

export type Theme = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

function readStoredTheme(): Theme {
  if (!browser) return "system";
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return isTheme(stored) ? stored : "system";
  } catch {
    // Safari in private mode throws on localStorage access rather than
    // returning null. A theme preference is never worth a crash.
    return "system";
  }
}

class ThemeState {
  /** The user's preference, which may be "system". */
  preference = $state<Theme>("system");

  /** Tracks the OS setting so "system" stays live rather than sampled once. */
  #systemDark = $state(false);

  /** What is actually painted: "system" collapsed to light or dark. */
  get resolved(): ResolvedTheme {
    if (this.preference === "system") {
      return this.#systemDark ? "dark" : "light";
    }
    return this.preference;
  }

  /**
   * Called once from the admin layout's onMount. Reads the stored
   * preference and subscribes to OS changes.
   */
  init(): () => void {
    if (!browser) return () => {};

    this.preference = readStoredTheme();

    const query = window.matchMedia("(prefers-color-scheme: dark)");
    this.#systemDark = query.matches;

    const onChange = (e: MediaQueryListEvent) => {
      this.#systemDark = e.matches;
      this.#apply();
    };
    query.addEventListener("change", onChange);

    this.#apply();
    return () => query.removeEventListener("change", onChange);
  }

  set(next: Theme): void {
    this.preference = next;
    if (!browser) return;
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Non-fatal — the theme still applies for this session.
    }
    this.#apply();
  }

  /** Cycles light → dark → system, which is what a single toggle button needs. */
  cycle(): void {
    const order: Theme[] = ["light", "dark", "system"];
    const i = order.indexOf(this.preference);
    this.set(order[(i + 1) % order.length]);
  }

  #apply(): void {
    if (!browser) return;
    const root = document.documentElement;
    root.classList.toggle("dark", this.resolved === "dark");
    // Drives the UA-rendered form controls, scrollbars and caret, which
    // ignore CSS classes entirely.
    root.style.colorScheme = this.resolved;
  }
}

export const theme = new ThemeState();

/**
 * Blocking script injected into `app.html`, before first paint.
 *
 * Kept here beside the state it mirrors, because the failure mode when
 * the two disagree is a flash of the wrong theme — cosmetic enough to
 * miss in review, and irritating enough to matter.
 */
export const THEME_INIT_SCRIPT = `
(function () {
  try {
    var stored = localStorage.getItem(${JSON.stringify(THEME_KEY)});
    var dark = stored === 'dark' ||
      ((stored === 'system' || stored === null) &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  } catch (e) {}
})();
`.trim();

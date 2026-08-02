/**
 * The admin design system.
 *
 * Import from here rather than reaching for individual files, so a
 * component can be relocated without touching 41 call sites.
 */
export { default as PageShell } from "./PageShell.svelte";
export { default as PageHeader } from "./PageHeader.svelte";
export { default as DataTable } from "./DataTable.svelte";
export { default as StatusBadge } from "./StatusBadge.svelte";
export { default as ThemeToggle } from "./ThemeToggle.svelte";
export { default as SaveBar } from "./SaveBar.svelte";
export { default as TableToolbar } from "./TableToolbar.svelte";
export type { Filter, FilterOption } from "./TableToolbar.svelte";

// CommandPalette is deliberately NOT exported here.
//
// It imports `sidebar-nav`, which imports the plugin registrations, whose
// module-eval `registerNavGroup()` calls run during `sidebar-nav`'s own
// initialization. Re-exporting the palette from this barrel puts that
// whole chain behind every `$lib/components/admin` import — so any of the
// 41 admin pages would drag it in, and the cycle resolves with
// `registerNavGroup` still undefined:
//
//   TypeError: registerNavGroup is not a function
//
// Same failure class as the `let _registry` TDZ crash in #134. The layout
// imports the palette directly from its own file, which keeps the cycle
// from ever forming.

export { DirtyState, guardUnsavedChanges } from "./dirty-state.svelte";

export type { ShellWidth } from "./PageShell.svelte";
export type { Crumb } from "./PageHeader.svelte";
export type { Column, SortDirection } from "./DataTable.svelte";
export { type StatusTone, toneForStatus } from "./StatusBadge.svelte";
export { theme, type Theme, type ResolvedTheme } from "./theme.svelte";

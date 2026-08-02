import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Guards the interaction layer: the save bar, the table toolbar and the
 * command palette.
 *
 * These three share a failure mode that type-checking cannot see — they
 * are keyboard- and screen-reader-facing, and every one of their
 * accessibility affordances is a string in the markup that a refactor
 * can drop without breaking a build or a visual review.
 */
const DIR = new URL(".", import.meta.url).pathname;
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

describe("SaveBar", () => {
  const src = read("SaveBar.svelte");

  it("sticks to the viewport", () => {
    // The entire point: "Save draft" sat 5860px down a 6050px page
    // against a 900px viewport, with nothing sticky.
    expect(src).toMatch(/\bsticky\b/);
    expect(src).toMatch(/bottom-0/);
  });

  it("only renders when dirty", () => {
    // A permanently visible bar costs ~64px on every page for an action
    // that is usually irrelevant.
    expect(src).toMatch(/\{#if dirty\}/);
  });

  it("announces politely rather than interrupting", () => {
    // role="alert" cuts off a screen reader mid-sentence — hostile when
    // it fires because the user is typing.
    expect(src).toContain('role="status"');
    expect(src).toContain('aria-live="polite"');
    // Matched against markup only — the comment above the element names
    // `role="alert"` to explain why it is not used, and a naive
    // whole-file search flags that prose as a violation.
    const markup = src.slice(src.indexOf("</script>"));
    expect(markup).not.toContain('role="alert"');
  });

  it("clears the iOS home indicator", () => {
    // A bottom-anchored control is partly untappable on a notched
    // iPhone without a safe-area inset.
    expect(src).toContain("safe-area-inset-bottom");
  });
});

describe("TableToolbar", () => {
  const src = read("TableToolbar.svelte");

  it("keeps search and filters in the URL", () => {
    // So a filtered view is linkable, survives reload, and works with
    // the back button — none of which component-local state gives you.
    expect(src).toContain("searchParams");
    expect(src).toContain("goto");
  });

  it("resets pagination when a filter changes", () => {
    // Staying on page 4 of a result set that now has two pages shows an
    // empty table and reads as data loss.
    expect(src).toMatch(/searchParams\.delete\(['"]page['"]\)/);
  });

  it("keeps focus in the search box across navigation", () => {
    // Without keepFocus every debounce tick steals the caret mid-word.
    expect(src).toContain("keepFocus");
  });

  it("debounces typing but not select changes", () => {
    // A select emits one event per decision; debouncing it only adds
    // latency to something already discrete.
    expect(src).toContain("setTimeout");
    expect(src).toContain("clearTimeout");
  });
});

describe("CommandPalette", () => {
  const src = read("CommandPalette.svelte");

  it("filters entries by role", () => {
    // Offering an editor a super-admin-only page produces a 403 on
    // navigation, and leaks what exists.
    expect(src).toContain("roles");
    expect(src).toContain("role");
  });

  it("reads the shared nav registry", () => {
    // Sharing the registry with the sidebar means a plugin's nav item
    // gets a palette entry for free, and the two cannot disagree.
    expect(src).toContain("listNavGroups");
  });

  it("binds to Cmd-K and Ctrl-K", () => {
    // metaKey alone would leave every Linux and Windows user without it.
    expect(src).toContain("metaKey");
    expect(src).toContain("ctrlKey");
  });

  it("supports arrow-key and Escape navigation", () => {
    expect(src).toContain("ArrowDown");
    expect(src).toContain("ArrowUp");
    expect(src).toContain("Escape");
    expect(src).toContain("Enter");
  });

  it("exposes combobox semantics to screen readers", () => {
    // Without aria-activedescendant the arrow keys move a purely visual
    // highlight and announce nothing.
    expect(src).toContain("aria-activedescendant");
    expect(src).toContain('role="listbox"');
    expect(src).toContain('role="option"');
    expect(src).toContain('aria-modal="true"');
  });

  it("gives the backdrop a real focusable control", () => {
    // A bare <div onclick> to dismiss is invisible to keyboard users.
    expect(src).toMatch(/<button[^>]*aria-label="Close"/);
  });

  it("clamps the cursor when results shrink", () => {
    // Otherwise Enter fires on an index past the end of the list.
    expect(src).toMatch(/activeIndex >= results\.length/);
  });
});

describe("DataTable", () => {
  const src = read("DataTable.svelte");

  it("scrolls rather than clips on mobile", () => {
    expect(src).toContain("overflow-x-auto");
    expect(src).not.toMatch(/overflow-hidden[^"]*">\s*<table/);
  });

  it("reports sort state to assistive tech", () => {
    // A visual arrow alone tells a screen-reader user nothing.
    expect(src).toContain("aria-sort");
  });

  it("requires a stable row key", () => {
    // Index keys corrupt row identity the moment the table is sorted —
    // checkboxes end up attached to the wrong records.
    expect(src).toContain("getKey");
    expect(src).toMatch(/#each rows as row \(getKey\(row\)\)/);
  });

  it("supports an indeterminate select-all", () => {
    // "Some but not all" is a distinct third state; without it the
    // header checkbox lies about a partial selection.
    expect(src).toContain("indeterminate");
  });

  it("links only the first cell, not the whole row", () => {
    // A row-wrapping anchor swallows the action buttons in the last
    // column, making them unclickable.
    expect(src).toContain("rowHref");
    expect(src).toMatch(/i === 0 && rowHref/);
  });
});

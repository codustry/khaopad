<script lang="ts">
  /**
   * Header search for the (www) storefront: a compact input that
   * submits (GET) to /[locale]/search?q=, with an as-you-type
   * dropdown fed by /api/public/shop/search.
   *
   * A11y follows the in-repo combobox idiom (RelationPicker /
   * CommandPalette: role="combobox" + aria-activedescendant over a
   * listbox) but is built for the www surface — no admin imports.
   *
   * Keyboard: ArrowUp/Down move the active option, Enter on an active
   * option goes to that product, plain Enter submits the form to the
   * full results page, Escape closes the dropdown.
   */
  import * as m from "$lib/paraglide/messages";
  import { goto } from "$app/navigation";
  import { localePath, toLocale } from "$lib/i18n";

  // $lib/i18n doesn't re-export the (server-typed) Locale; derive it.
  type Locale = ReturnType<typeof toLocale>;

  let { locale }: { locale: Locale } = $props();

  type Hit = { slug: string; title: string; priceFromSatang: number | null };

  let query = $state("");
  let results = $state<Hit[]>([]);
  let open = $state(false);
  // -1 = no option active; plain Enter then submits the form.
  let activeIndex = $state(-1);
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestSeq = 0;

  const listboxId = "header-search-listbox";
  const optionId = (i: number) => `header-search-option-${i}`;

  function search(q: string) {
    clearTimeout(debounceTimer);
    // MIN_QUERY_LENGTH server-side is 2; mirror it here to skip
    // pointless round-trips.
    if (q.length < 2) {
      results = [];
      return;
    }
    debounceTimer = setTimeout(async () => {
      const seq = ++requestSeq;
      try {
        const res = await fetch(
          `/api/public/shop/search?q=${encodeURIComponent(q)}&locale=${locale}`,
        );
        if (!res.ok) return;
        const body = (await res.json()) as { results: Hit[] };
        // Drop stale responses that resolve out of order.
        if (seq !== requestSeq) return;
        results = body.results;
        open = true;
      } catch {
        // Network hiccup — the form submit path still works.
      }
    }, 250);
  }

  function onInput(event: Event) {
    query = (event.target as HTMLInputElement).value;
    activeIndex = -1;
    open = true;
    search(query.trim());
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "ArrowDown" && results.length > 0) {
      event.preventDefault();
      open = true;
      activeIndex = (activeIndex + 1) % results.length;
    } else if (event.key === "ArrowUp" && results.length > 0) {
      event.preventDefault();
      open = true;
      activeIndex = (activeIndex - 1 + results.length) % results.length;
    } else if (event.key === "Enter") {
      if (open && activeIndex >= 0 && results[activeIndex]) {
        event.preventDefault();
        open = false;
        goto(localePath(locale, `/products/${results[activeIndex].slug}`));
      }
      // else: let the form submit to /[locale]/search?q=
    } else if (event.key === "Escape") {
      if (open) {
        event.preventDefault();
        open = false;
      }
    }
  }
</script>

<form
  method="GET"
  action={localePath(locale, "/search")}
  role="search"
  class="relative"
>
  <input
    type="search"
    name="q"
    role="combobox"
    aria-label={m.shop_search_label()}
    aria-expanded={open && results.length > 0}
    aria-controls={listboxId}
    aria-autocomplete="list"
    aria-activedescendant={open && activeIndex >= 0 && results[activeIndex]
      ? optionId(activeIndex)
      : undefined}
    autocomplete="off"
    placeholder={m.shop_search_placeholder()}
    value={query}
    oninput={onInput}
    onkeydown={onKeydown}
    onfocus={() => {
      if (results.length > 0) open = true;
    }}
    onblur={() => (open = false)}
    class="w-32 sm:w-44 px-2 py-1 border border-input rounded text-xs bg-background focus:w-44 sm:focus:w-56 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  />

  {#if open && results.length > 0}
    <!-- onmousedown preventDefault keeps the input's blur from
		     closing the list before an option's click lands. -->
    <ul
      id={listboxId}
      role="listbox"
      aria-label={m.shop_search_products_heading()}
      onmousedown={(e) => e.preventDefault()}
      class="absolute right-0 z-20 mt-1 w-64 max-h-80 overflow-y-auto rounded-md border border-border bg-background p-1 shadow-lg text-left"
    >
      {#each results as hit, i (hit.slug)}
        <li role="none">
          <a
            id={optionId(i)}
            role="option"
            aria-selected={i === activeIndex}
            href={localePath(locale, `/products/${hit.slug}`)}
            onclick={() => (open = false)}
            onmouseenter={() => (activeIndex = i)}
            class="block truncate rounded px-2 py-1.5 text-sm {i === activeIndex
              ? 'bg-muted'
              : ''}"
          >
            {hit.title}
          </a>
        </li>
      {/each}
      <li role="none" class="border-t border-border mt-1 pt-1">
        <a
          role="option"
          aria-selected={false}
          href="{localePath(locale, '/search')}?q={encodeURIComponent(
            query.trim(),
          )}"
          onclick={() => (open = false)}
          class="block truncate rounded px-2 py-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          {m.shop_search_view_all({ query: query.trim() })}
        </a>
      </li>
    </ul>
  {/if}
</form>

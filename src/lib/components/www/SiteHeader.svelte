<script lang="ts">
  /**
   * Default storefront header — Step 2 of the theme/engine split (#174).
   *
   * Extracted verbatim from `(www)/+layout.svelte` so a deployment can
   * replace the whole thing without touching the layout, which also carries
   * SEO, consent, analytics and the theme-token plumbing every site wants.
   *
   * Before this, `(www)/+layout.svelte` was the single worst merge conflict in
   * the project: 86 lines upstream, 585 in a real fork, diverging in opposite
   * directions every release. Upstream's version is right *as a demo*; a
   * deployment's is right *as a storefront*. Neither is a better
   * implementation of one artefact, so no merge resolution was ever correct.
   *
   * Everything here is presentation. It reads from `data` and renders; it owns
   * no commerce logic, so replacing it cannot break cart, checkout or pricing.
   * That boundary is the point: chrome is deployment-owned, commerce is not.
   */
  import * as m from "$lib/paraglide/messages";
  import { localePath, toLocale } from "$lib/i18n";
  import HeaderSearch from "$lib/components/www/HeaderSearch.svelte";
  import { ShoppingCart, User } from "lucide-svelte";

  type NavItem = { id: string; href: string; label: string };

  let {
    locale,
    siteName,
    logoMediaId = null,
    primaryNav = [],
    hasCareers = false,
    cartItemCount = 0,
    alternateHref,
  }: {
    locale: string;
    siteName: string;
    logoMediaId?: string | null;
    primaryNav?: readonly NavItem[];
    hasCareers?: boolean;
    cartItemCount?: number;
    alternateHref: string;
  } = $props();

  const loc = $derived(toLocale(locale));
</script>

<header class="border-b border-border">
  <div class="container mx-auto px-4 py-4 flex items-center justify-between">
    <a href="/" class="flex items-center gap-2 text-xl font-bold">
      {#if logoMediaId}
        <img src={`/api/media/${logoMediaId}`} alt="" class="h-8 w-auto" height="32" />
      {/if}
      {siteName}</a
    >
    <nav class="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-sm">
      {#each primaryNav as item (item.id)}
        <a href={item.href} class="hover:text-primary">{item.label}</a>
      {/each}
      <a href={localePath(loc, "/blog")} class="hover:text-primary">
        {m.nav_blog()}
      </a>
      <a href={localePath(loc, "/products")} class="hover:text-primary">
        {m.nav_shop()}
      </a>
      {#if hasCareers}
        <a href={localePath(loc, "/careers")} class="hover:text-primary">
          {m.careers_nav()}
        </a>
      {/if}
      <HeaderSearch locale={loc} />
      <a
        href={localePath(loc, "/account")}
        class="hover:text-primary"
        aria-label={m.nav_account()}
        title={m.nav_account()}
      >
        <User class="h-5 w-5" aria-hidden="true" />
      </a>
      <!-- Persistent cart entry point. Before this, the only route to
           the cart was a transient "View cart" link beside add-to-cart
           that vanished on the next navigation. -->
      <a
        href={localePath(loc, "/cart")}
        class="relative hover:text-primary"
        aria-label={cartItemCount === 0
          ? m.nav_cart()
          : cartItemCount === 1
            ? m.nav_cart_count_one()
            : m.nav_cart_count({ count: cartItemCount })}
        title={m.nav_cart()}
      >
        <ShoppingCart class="h-5 w-5" aria-hidden="true" />
        {#if cartItemCount > 0}
          <span
            class="absolute -right-2 -top-2 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium leading-none text-primary-foreground tabular-nums"
            aria-hidden="true"
          >
            {cartItemCount > 99 ? "99+" : cartItemCount}
          </span>
        {/if}
      </a>
      <a
        href={alternateHref}
        data-sveltekit-reload
        class="px-2 py-1 border border-border rounded text-xs hover:bg-muted"
      >
        {m.lang_switch()}
      </a>
    </nav>
  </div>
</header>

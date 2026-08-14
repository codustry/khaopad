<script lang="ts">
  /**
   * Default storefront footer — Step 2 of the theme/engine split (#174).
   *
   * Companion to SiteHeader.svelte; see that file for the reasoning. Pure
   * presentation, replaceable wholesale by a deployment via the layout's
   * `footer` snippet prop.
   */
  import * as m from "$lib/paraglide/messages";

  type NavItem = { id: string; href: string; label: string };

  let {
    footerNav = [],
  }: {
    footerNav?: readonly NavItem[];
  } = $props();
</script>

<footer class="border-t border-border py-8 text-sm text-muted-foreground">
  <div
    class="container mx-auto px-4 flex flex-col sm:flex-row items-center justify-between gap-3"
  >
    <p>{m.footer_copyright({ year: new Date().getFullYear().toString() })}</p>
    {#if footerNav.length > 0}
      <nav class="flex flex-wrap gap-4">
        {#each footerNav as item (item.id)}
          <a href={item.href} class="hover:text-foreground">{item.label}</a>
        {/each}
      </nav>
    {/if}
  </div>
</footer>

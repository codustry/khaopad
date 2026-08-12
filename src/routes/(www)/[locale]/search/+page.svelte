<script lang="ts">
  import * as m from "$lib/paraglide/messages";
  import { formatDate } from "$lib/utils";
  import { localePath, toLocale } from "$lib/i18n";
  import { formatSatang, satang } from "$plugins/shop/money";

  let { data } = $props();
  const locale = $derived.by(() => toLocale(data.locale));
  const hasResults = $derived(
    data.products.length > 0 || data.articles.length > 0,
  );
</script>

<!-- SEO (incl. noindex,follow) is handled by the layout's <Seo />. -->

<section class="container mx-auto px-4 py-12">
  <h1 class="text-3xl font-bold mb-4">{m.shop_search_page_title()}</h1>

  <!-- Plain GET so the URL is shareable — same rationale as /blog?q=. -->
  <form method="GET" class="mb-8 flex flex-wrap gap-2" role="search">
    <input
      type="search"
      name="q"
      value={data.q ?? ""}
      placeholder={m.shop_search_placeholder()}
      class="flex-1 min-w-[220px] px-3 py-2 border border-input rounded-md bg-background text-sm"
    />
    <button
      type="submit"
      class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:opacity-90"
    >
      {m.shop_search_submit()}
    </button>
  </form>

  {#if !data.q}
    <p class="text-muted-foreground">{m.shop_search_empty_prompt()}</p>
  {:else if data.tooShort}
    <p class="text-muted-foreground">{m.shop_search_min_length()}</p>
  {:else if !hasResults}
    <p class="text-muted-foreground">
      {m.shop_search_no_results({ query: data.q })}
    </p>
  {:else}
    <p class="mb-6 text-sm text-muted-foreground">
      {m.shop_search_results_for({ query: data.q })}
    </p>

    <h2 class="text-xl font-semibold mb-3">
      {m.shop_search_products_heading()}
    </h2>
    {#if data.products.length === 0}
      <p class="mb-8 text-sm text-muted-foreground">
        {m.shop_search_no_products()}
      </p>
    {:else}
      <div class="mb-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
        {#each data.products as product (product.productId)}
          <!--
            The anchor wrapped an <h3> but exposed no accessible name, so
            screen readers announced a bare "link". aria-label gives the
            link the product's title regardless of how the heading is
            nested.
          -->
          <a
            href={localePath(locale, `/products/${product.slug}`)}
            aria-label={product.title}
            class="border border-border rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col gap-1"
          >
            <h3 class="font-semibold">{product.title}</h3>
            {#if product.priceFromSatang !== null}
              <p class="text-sm text-muted-foreground">
                {formatSatang(satang(product.priceFromSatang), locale)}
              </p>
            {/if}
          </a>
        {/each}
      </div>
    {/if}

    <h2 class="text-xl font-semibold mb-3">
      {m.shop_search_articles_heading()}
    </h2>
    {#if data.articles.length === 0}
      <p class="text-sm text-muted-foreground">{m.shop_search_no_articles()}</p>
    {:else}
      <div class="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {#each data.articles as article (article.id)}
          {@const loc =
            article.localizations[locale] ??
            Object.values(article.localizations)[0]}
          {#if loc}
            <article
              class="border border-border rounded-lg p-6 hover:shadow-md transition-shadow"
            >
              <!-- Same missing-accessible-name bug as the product results. -->
              <a
                href={localePath(locale, `/blog/${article.slug}`)}
                aria-label={loc.title}
                class="block"
              >
                <h3 class="text-lg font-semibold mb-2">{loc.title}</h3>
                {#if loc.excerpt}
                  <p class="text-muted-foreground text-sm mb-4">
                    {loc.excerpt}
                  </p>
                {/if}
                <time class="text-xs text-muted-foreground">
                  {formatDate(article.publishedAt ?? article.createdAt, locale)}
                </time>
              </a>
            </article>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}
</section>

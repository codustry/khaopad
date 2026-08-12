import { CONSENT_COOKIE, parseConsent } from "$lib/consent";
import { loadNavigation, navItemHref } from "$lib/server/content/navigation";
import type { Locale } from "$lib/server/content/types";
import { CartService } from "$plugins/shop/cart-service";
import { readCartSession } from "$plugins/shop/cart-cookie";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({
  locals,
  cookies,
  platform,
  depends,
}) => {
  const siteSettings = await locals.content.getSettings().catch(() => null);
  const consent = parseConsent(cookies.get(CONSENT_COOKIE));

  // Only offer the cookie banner's "learn more" link when a privacy page
  // actually exists. The href used to be hardcoded, so every install
  // without a page at /privacy-policy shipped a 404 on its consent
  // banner — the one link on that banner that legally ought to work.
  // Looked up rather than configured so it self-corrects when an operator
  // publishes (or unpublishes) the page.
  const privacyPage = await locals.content
    .getPageBySlug("privacy-policy")
    .catch(() => null);
  const hasPrivacyPage =
    !!privacyPage &&
    (privacyPage as { status?: string }).status === "published";

  // v1.7b: pre-resolve the primary + footer menus into render-ready
  // arrays so the layout's header/footer can iterate without doing
  // any database work itself.
  const locale = (locals.locale ?? "en") as Locale;
  const nav = await loadNavigation(locals.content, ["primary", "footer"]);
  const renderMenu = (key: string) => {
    const menu = nav.menus[key];
    if (!menu) return [];
    return menu.items
      .filter((it) => !it.parentId)
      .sort((a, b) => a.position - b.position)
      .map((it) => ({
        id: it.id,
        href: navItemHref(it, locale, nav),
        label: it.labels[locale] ?? it.labels.en ?? "",
      }))
      .filter((x) => x.label && x.href !== "#");
  };

  // Header cart badge. `readCartSession` rather than `ensureCartSession`
  // so a visitor who never touched the shop doesn't get a cart cookie
  // minted on every page of the site. `depends` lets the cart page's
  // existing `invalidate('/api/shop/cart')` refresh the badge without a
  // full reload, so the count stays live after add/remove/qty changes.
  depends("/api/shop/cart");
  const cartItemCount = await (async () => {
    const env = platform?.env;
    if (!env) return 0;
    // No cart cookie means no cart yet — skip the query entirely rather
    // than calling ensureCart(), which would INSERT an empty cart row
    // for every anonymous visitor who merely loaded the home page.
    const sessionId = readCartSession(cookies);
    if (!sessionId) return 0;
    try {
      const svc = new CartService(env.DB);
      const cart = await svc.ensureCart({ sessionId, userId: locals.user?.id });
      const items = await svc.listCartItems(cart.id);
      return items.reduce((sum, i) => sum + i.quantity, 0);
    } catch {
      // A broken cart query must never take the whole site down —
      // degrade to a badge-less cart icon.
      return 0;
    }
  })();

  return {
    locale: locals.locale,
    siteSettings,
    consent,
    hasPrivacyPage,
    cartItemCount,
    nav: {
      primary: renderMenu("primary"),
      footer: renderMenu("footer"),
    },
  };
};

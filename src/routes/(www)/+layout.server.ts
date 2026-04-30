import { CONSENT_COOKIE, parseConsent } from "$lib/consent";
import { loadNavigation, navItemHref } from "$lib/server/content/navigation";
import type { Locale } from "$lib/server/content/types";
import type { LayoutServerLoad } from "./$types";

export const load: LayoutServerLoad = async ({ locals, cookies }) => {
  const siteSettings = await locals.content.getSettings().catch(() => null);
  const consent = parseConsent(cookies.get(CONSENT_COOKIE));

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

  return {
    locale: locals.locale,
    siteSettings,
    consent,
    nav: {
      primary: renderMenu("primary"),
      footer: renderMenu("footer"),
    },
  };
};

import { resolve } from "$app/paths";

/**
 * {@link resolve} with a string path when the route is not in the generated manifest yet.
 * Kept in `.ts` so Svelte files never contain `as` (the compiler misparses assertions in scripts).
 */
const looseResolve = resolve as (path: string) => string;

export const cmsHref = {
  media: looseResolve("/media"),
  categories: looseResolve("/categories"),
  users: looseResolve("/users"),
  settings: looseResolve("/settings"),
  articlesNew: looseResolve("/articles/new"),
  article: (id: string) => looseResolve(`/articles/${id}`),
};

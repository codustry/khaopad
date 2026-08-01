import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      routes: {
        include: ["/*"],
        exclude: ["<all>"],
      },
    }),
    // Absolute asset paths. SvelteKit defaults to `relative: true`, which
    // emits the hydration bootstrap as a RELATIVE import:
    //
    //     import("../_app/immutable/entry/start.<hash>.js")
    //
    // From a nested route that resolves against the page URL, so
    // /admin/login requested /admin/_app/... → 404. Hydration never
    // started, and every form fell back to a native submit: the login
    // page cleared its fields and showed no error, because the JS handler
    // that calls /api/auth/sign-in was never attached.
    //
    // Only single-segment routes worked (/en emitted "./_app/..."), which
    // is why the homepage looked fine while everything below it was inert.
    //
    // Relative paths only matter when serving from an unknown base path;
    // this app is always served from the domain root.
    paths: {
      relative: false,
    },
    alias: {
      $components: "src/lib/components",
      $plugins: "src/plugins",
    },
  },
};

export default config;

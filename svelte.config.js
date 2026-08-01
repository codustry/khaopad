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
    // Let SvelteKit generate the CSP so it can NONCE its own inline
    // hydration bootstrap.
    //
    // hooks.server.ts previously set `script-src 'self'` by hand, on the
    // reasoning that "public HTML never legitimately needs inline JS".
    // But SvelteKit's bootstrap IS inline JS, emitted on every page — so
    // the browser refused it, hydration never ran, and the entire app was
    // served as inert HTML. Forms did native submits; the login page
    // cleared its fields and showed no error.
    //
    // `mode: "auto"` emits a nonce for the inline bootstrap (and hashes
    // for prerendered pages), which keeps the policy strict — strictly
    // BETTER than 'unsafe-inline', which would have been the tempting fix
    // and would have re-opened the stored-XSS hole the CSP exists to close.
    csp: {
      mode: "auto",
      directives: {
        "default-src": ["self"],
        "script-src": ["self"],
        // bits-ui / svelte-sonner emit inline style attributes.
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:", "blob:", "https:"],
        "media-src": ["self", "data:", "blob:", "https:"],
        "font-src": ["self", "data:"],
        "connect-src": ["self"],
        "frame-ancestors": ["none"],
        "form-action": ["self"],
        "base-uri": ["self"],
        "object-src": ["none"],
      },
    },
    alias: {
      $components: "src/lib/components",
      $plugins: "src/plugins",
    },
  },
};

export default config;

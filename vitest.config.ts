import { defineConfig } from "vitest/config";

/**
 * Test config — deliberately SEPARATE from vite.config.ts.
 *
 * The app config loads the SvelteKit and Paraglide plugins, which expect
 * a full SvelteKit build context. Unit tests here exercise plain
 * TypeScript modules (services, unit conversion, form encoding), so
 * pulling those plugins in would only add failure modes.
 *
 * Tests that need a real D1 or a running Worker belong in a separate
 * integration project once one exists; see the note in
 * `src/lib/server/content/attributes/units.test.ts` about what unit
 * tests can and cannot prove here.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Mirror svelte.config.js so imports resolve identically. Kept in
      // sync by hand — there is no shared source for these yet.
      $lib: new URL("./src/lib", import.meta.url).pathname,
      $plugins: new URL("./src/plugins", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{js,ts}"],
    // Generated output and build artefacts are never worth testing.
    exclude: [
      "node_modules/**",
      ".svelte-kit/**",
      "src/lib/paraglide/**",
      "src/paraglide/**",
    ],
    environment: "node",
    // Node built-ins (node:fs) are used by structural tests that read
    // source files. The app tsconfig targets the browser, so those tests
    // live under a `*.node.test.ts` name and get @types/node via this
    // config rather than polluting the app's global types.
    // Fail loudly rather than silently passing on zero tests — a config
    // change that stops matching any file should break CI, not go green.
    passWithNoTests: false,
    // A test FILE that dies before running counts as a failure, not an
    // absence. When better-sqlite3 was loaded under Node 20 (it requires
    // >=22) the worker was killed outright, and the summary read
    // "26 passed (46)" with a non-obvious unhandled error above it — the
    // 20 integration tests never executed. dangerouslyIgnoreUnhandledErrors
    // stays false (the default) for the same reason: a crashed worker must
    // never be reportable as a pass.
    dangerouslyIgnoreUnhandledErrors: false,
  },
});

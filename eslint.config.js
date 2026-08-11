import prettier from "eslint-config-prettier";
import path from "node:path";
import { includeIgnoreFile } from "@eslint/compat";
import js from "@eslint/js";
import svelte from "eslint-plugin-svelte";
import { defineConfig } from "eslint/config";
import globals from "globals";
import ts from "typescript-eslint";
import svelteConfig from "./svelte.config.js";

const gitignorePath = path.resolve(import.meta.dirname, ".gitignore");

export default defineConfig(
  includeIgnoreFile(gitignorePath),
  js.configs.recommended,
  ts.configs.recommended,
  svelte.configs.recommended,
  prettier,
  svelte.configs.prettier,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
      // see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
      "no-undef": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    files: ["**/*.svelte", "**/*.svelte.ts", "**/*.svelte.js"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        extraFileExtensions: [".svelte"],
        parser: ts.parser,
        svelteConfig,
      },
    },
  },
  {
    // Override or add rule settings here, such as:
    // 'svelte/button-has-type': 'error'
    rules: {},
  },
  {
    // CMS routes use root-relative paths; `(www)` uses `localePath()` for
    // locale-prefixed URLs; shared CMS shell components and UI primitives
    // accept absolute hrefs as props or render hardcoded admin links.
    files: [
      "src/routes/(cms)/**/*.svelte",
      "src/routes/(www)/**/*.svelte",
      "src/lib/components/cms/**/*.svelte",
      "src/lib/components/ui/**/*.svelte",
      // The admin design system (PageHeader breadcrumbs, DataTable
      // rowHref, CommandPalette, TableToolbar) takes hrefs as props or
      // navigates to the current route with new query params. There is no
      // build-time route ID for any of them to resolve.
      "src/lib/components/admin/**/*.svelte",
      // Storefront shop components (ProductCard, FacetSidebar, chips,
      // pagination) build locale-prefixed hrefs via localePath() + URL
      // query serialization — same story as (www) routes: no build-time
      // route ID to resolve.
      "src/lib/components/shop/**/*.svelte",
      // Same again for shared www-surface components (HeaderSearch):
      // locale-prefixed search URLs built at runtime.
      "src/lib/components/www/**/*.svelte",
    ],
    rules: {
      "svelte/no-navigation-without-resolve": "off",
    },
  },
);

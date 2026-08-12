/**
 * @khaopad/plugin-careers — public careers page fed by an external ATS.
 *
 * Renders `/{locale}/careers` from a Greenhouse/Lever-shaped JSON feed
 * (Tonbab People, `GET /api/careers/{slug}/jobs`). Applications are
 * NOT handled here: each opening links out to the ATS-hosted
 * `apply_url` wizard.
 *
 * Deliberately minimal as a plugin object:
 *   - **No tables, no migrations.** All state lives in the upstream
 *     ATS; the only persistence is a KV cache entry.
 *   - **No admin routes, no sidebar nav.** There is nothing to edit in
 *     the CMS — job postings are authored in the ATS. Registering a
 *     nav group that only ever said "go configure this elsewhere"
 *     would be noise in every install's sidebar.
 *   - **No onInit.** Nothing to warm; the route resolves config per
 *     request so a `CAREERS_FEED_URL` change takes effect without a
 *     cold start.
 *
 * Configuration and behaviour are documented in `README.md` next to
 * this file.
 *
 * Files:
 *   feed.ts    — pure parsing/normalization of untrusted feed JSON
 *   service.ts — fetch + timeout + KV cache + stale-on-error
 *   jsonld.ts  — JobPosting structured data
 *   src/routes/(www)/[locale]/careers/ — the page itself
 */
import { defineKhaopadPlugin } from "$lib/plugins/types";

export default defineKhaopadPlugin({
  slug: "careers",
  name: "Careers",
  version: "0.1.0",
  description:
    "Public careers page rendered from an external ATS job feed (Tonbab People)",
});

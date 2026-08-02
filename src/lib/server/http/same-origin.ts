import { json } from "@sveltejs/kit";

/**
 * Same-origin guard for state-changing API routes.
 *
 * ## Why this is shared
 *
 * This existed as THREE copies pasted across shop routes, and they had
 * already diverged: `cart/discount` rejected a request with no `Origin`
 * header, while `cart` waved it through with
 *
 *     if (!origin) return null; // same-origin fetch usually omits it
 *
 * That reasoning is outdated — per the Fetch spec browsers have sent
 * `Origin` on every POST, same-origin included, since ~2020. So an absent
 * header means a non-browser client, and a guard whose entire job is to
 * establish provenance should not wave that through.
 *
 * Copies of a security check drift silently. One implementation cannot.
 *
 * ## What this is and isn't
 *
 * This is defence in depth, NOT the primary CSRF control. `SameSite=Lax`
 * on the session and cart cookies is what actually stops a cross-site
 * POST from carrying credentials. This layer catches the residue:
 * non-browser clients, and browsers on paths where SameSite is weaker.
 *
 * Returns `null` to continue, or a `Response` to short-circuit.
 */
export function requireSameOrigin(request: Request, url: URL): Response | null {
  // GET/HEAD are read-only; provenance doesn't matter.
  if (request.method === "GET" || request.method === "HEAD") return null;

  // `Sec-Fetch-Site` is set by the browser and is NOT settable by page
  // script, so it beats `Origin` (which a non-browser client controls
  // completely) when present.
  //   same-origin → our own page
  //   none        → direct navigation / typed URL / bookmark
  //   same-site   → a sibling subdomain; not trusted for state changes
  //   cross-site  → another site
  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite) {
    if (secFetchSite === "same-origin" || secFetchSite === "none") return null;
    return json({ ok: false, code: "CROSS_ORIGIN_FORBIDDEN" }, { status: 403 });
  }

  const origin = request.headers.get("origin");
  if (!origin) {
    return json({ ok: false, code: "MISSING_ORIGIN" }, { status: 403 });
  }

  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return json({ ok: false, code: "MALFORMED_ORIGIN" }, { status: 400 });
  }

  if (originHost !== url.host) {
    return json({ ok: false, code: "CROSS_ORIGIN_FORBIDDEN" }, { status: 403 });
  }
  return null;
}

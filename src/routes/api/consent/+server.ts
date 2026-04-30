import { json } from "@sveltejs/kit";
import {
  CONSENT_COOKIE,
  CONSENT_MAX_AGE_S,
  CONSENT_VERSION,
  serializeConsent,
} from "$lib/consent";
import type { RequestHandler } from "./$types";

/**
 * POST /api/consent
 *
 * Records a visitor's cookie-consent decision in a first-party cookie.
 * Payload is a multipart form with optional booleans `analytics` and
 * `marketing` (presence = opted in). Always sets `ts` to now.
 *
 * No body parsing dependencies, no third-party calls. Same-site Lax
 * so the cookie survives normal navigation but isn't sent on
 * cross-origin POSTs.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
  const form = await request.formData();
  const analytics = form.get("analytics") !== null;
  const marketing = form.get("marketing") !== null;
  const record = {
    ts: new Date().toISOString(),
    analytics,
    marketing,
    v: CONSENT_VERSION,
  };
  cookies.set(CONSENT_COOKIE, serializeConsent(record), {
    path: "/",
    httpOnly: false, // readable by client so the banner can hide
    sameSite: "lax",
    secure: true,
    maxAge: CONSENT_MAX_AGE_S,
  });
  return json({ ok: true, consent: record });
};

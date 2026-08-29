/**
 * GET/POST /api/telemetry/cron — weekly anonymous install ping (#199).
 *
 * Mirrors the shop sweep endpoint's shape (Cron Triggers fetch a URL;
 * the shared secret is the only guard) rather than inventing a second
 * cron convention. See docs/TELEMETRY.md for what is sent, and
 * `$lib/server/telemetry/payload.ts` for why it is anonymous by
 * construction rather than by promise.
 *
 * This endpoint is the ONLY caller of the sender. Telemetry is
 * deliberately absent from every user-request path: no visitor, editor
 * or deploy ever waits on it, so a slow or dead collector cannot show
 * up as a slow site.
 *
 * Sending is off unless the operator opted in (Settings → Telemetry).
 * Hitting this endpoint on a site that has not opted in is a no-op that
 * reports `{ sent: false, reason: "not-enabled" }`.
 */
import { error, json } from "@sveltejs/kit";
import { maybeSendTelemetry } from "$lib/server/telemetry";
import { readContentCounts } from "$lib/server/telemetry/counts";
import type { RequestHandler } from "./$types";

function guard(request: Request, env: App.Platform["env"]) {
  const header = request.headers.get("x-cron-secret") ?? "";
  const url = new URL(request.url);
  const token = header || url.searchParams.get("token") || "";
  const expected = env.CRON_SECRET ?? "";
  if (!expected || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) {
    diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

async function run(
  request: Request,
  platform: App.Platform | undefined,
  locals: App.Locals,
) {
  const env = platform?.env;
  if (!env) throw error(503, "Platform not ready");
  if (!guard(request, env)) throw error(401, "Invalid or missing token");

  const counts = env.DB
    ? await readContentCounts(env.DB)
    : { articles: 0, pages: 0, users: 0 };

  // Cloudflare hands the continent over for free on every request; we
  // coarsen it to a continent bucket inside the sender.
  const continent = (request as Request & { cf?: { continent?: string } }).cf
    ?.continent;

  const result = await maybeSendTelemetry({
    env: env as unknown as Record<string, unknown>,
    content: locals.content,
    counts,
    continent,
  });
  return json({ ok: true, ...result });
}

export const POST: RequestHandler = ({ request, platform, locals }) =>
  run(request, platform, locals);

export const GET: RequestHandler = ({ request, platform, locals }) =>
  run(request, platform, locals);

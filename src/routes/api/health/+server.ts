import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";

/**
 * GET /api/health
 *
 * Liveness + reachability probe (v1.9). Returns 200 with a JSON body
 * listing whether each Cloudflare binding (D1, R2, KV) is reachable
 * from the worker. Used by the smoke-test job in `.github/workflows/
 * deploy.yml` and by external uptime monitors.
 *
 * The endpoint never throws — a failed binding shows up as
 * `{ ok: false, error: "..." }` in the response body, never as a
 * 5xx. This way an uptime monitor watching for HTTP 200 can still
 * see the binding-level failure in the JSON. We do return 503 only
 * when the platform shim itself is missing (local dev without
 * `wrangler pages dev`), since at that point nothing else works.
 *
 * No auth gate — the response intentionally exposes nothing
 * sensitive (timestamps + boolean reachability flags).
 */
export const GET: RequestHandler = async ({ platform }) => {
  if (!platform?.env) {
    return json(
      {
        ok: false,
        error: "Platform bindings unavailable (running without wrangler?)",
      },
      { status: 503 },
    );
  }

  // App.Platform's `env` is the typed binding shape, but `WORKERS_ENV`
  // is a [vars] entry — not in the type. Cast through unknown for the
  // optional read; the typed bindings stay typed.
  const env = platform.env;
  const extra = env as unknown as { WORKERS_ENV?: string };
  const checks = await Promise.all([
    probeD1(env.DB),
    probeR2(env.MEDIA_BUCKET),
    probeKV(env.CONTENT_CACHE),
  ]);
  const [d1, r2, kv] = checks;

  const okAll = d1.ok && r2.ok && kv.ok;
  const body: Record<string, unknown> = {
    ok: okAll,
    timestamp: new Date().toISOString(),
    bindings: { d1, r2, kv },
  };
  if (extra.WORKERS_ENV) body.environment = extra.WORKERS_ENV;

  return json(body, {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
};

async function probeD1(
  db: D1Database | undefined,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!db) return { ok: false, error: "DB binding missing" };
  try {
    const t0 = Date.now();
    await db.prepare("SELECT 1").first();
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeR2(
  bucket: R2Bucket | undefined,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!bucket) return { ok: false, error: "MEDIA binding missing" };
  try {
    const t0 = Date.now();
    // List with prefix that almost certainly returns 0 results — we
    // only care that R2 acknowledged the call, not the data.
    await bucket.list({ limit: 1 });
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function probeKV(
  kv: KVNamespace | undefined,
): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  if (!kv) return { ok: false, error: "KV binding missing" };
  try {
    const t0 = Date.now();
    await kv.get("__health_probe__");
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

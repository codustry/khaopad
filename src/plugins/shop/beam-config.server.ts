/**
 * Server-only resolution of BeamCheckout credentials.
 *
 * ## Why this is a separate `.server.ts` file
 *
 * `src/plugins/shop/index.ts` is reachable from the browser bundle:
 *
 *   admin/+layout.svelte → Sidebar.svelte → sidebar-nav.ts
 *     → plugins/registrations.ts → plugins/shop/index.ts
 *
 * That chain exists because plugins contribute sidebar entries, which must
 * render on the client after hydration. Importing the secrets service from
 * `index.ts` therefore pulls decryption code — and the HKDF derivation from
 * BETTER_AUTH_SECRET — toward the client bundle. SvelteKit's
 * `vite-plugin-sveltekit-guard` correctly refuses to build that, and it is
 * right to: it is exactly the leak this feature must not introduce.
 *
 * Keeping resolution here, imported only from server-side request handlers,
 * means the browser graph never reaches it.
 *
 * ## Why resolve per-request rather than once at plugin init
 *
 * Secrets are now runtime-editable from /admin/settings/secrets. A provider
 * constructed once during `onInit` would capture whatever key existed at
 * boot and keep using it after an admin rotates it — silently charging
 * against a revoked key until the isolate recycled. Resolving at the point
 * of use costs one indexed primary-key lookup and is always current.
 */
import { getSecrets } from "$lib/server/secrets/service";
import { BeamPaymentProvider } from "./beam";
import { getPaymentProvider, type PaymentProvider } from "./payment";

type BeamEnv = Record<string, unknown> & {
  DB: D1Database;
  BEAM_BASE_URL?: string;
};

/**
 * Build a Beam provider from the currently-effective credentials, or null
 * when unconfigured.
 *
 * Null rather than throw: the shop still serves catalog and cart without
 * payment credentials, and checkout surfaces a purposeful 503 instead of
 * every page 500-ing.
 */
export async function resolveBeamProvider(
  env: BeamEnv,
): Promise<PaymentProvider | null> {
  const resolved = await getSecrets(env, [
    "BEAM_MERCHANT_ID",
    "BEAM_API_KEY",
    "BEAM_WEBHOOK_SECRET",
  ]);
  const merchantId = resolved.BEAM_MERCHANT_ID;
  const apiKey = resolved.BEAM_API_KEY;
  const webhookSecret = resolved.BEAM_WEBHOOK_SECRET;
  // All three are required: merchantId is the HTTP Basic username, so a
  // provider built without it would 401 on every call.
  if (!merchantId || !apiKey || !webhookSecret) return null;

  return new BeamPaymentProvider({
    merchantId,
    apiKey,
    webhookSecret,
    baseUrl: env.BEAM_BASE_URL,
  });
}

/**
 * Get a payment provider for a request, preferring one registered from env
 * at plugin init and falling back to DB-stored credentials.
 *
 * The two paths exist because env credentials are registered eagerly in
 * `onInit` (cheap, no DB round-trip) while DB credentials cannot be — see
 * the module comment above. Callers on the server should use this rather
 * than `getPaymentProvider` directly, or a site configured purely through
 * the admin UI would report "no payment provider" despite being set up.
 */
export async function resolveProviderForRequest(
  env: BeamEnv,
  name: string,
): Promise<PaymentProvider | null> {
  const registered = getPaymentProvider(name);
  if (registered) return registered;
  // Only Beam has a DB-credential path today. Other providers keep their
  // existing env-only registration.
  if (name !== "beam") return null;
  return resolveBeamProvider(env);
}

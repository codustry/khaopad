/**
 * Registry of secrets manageable from /admin/settings/secrets.
 *
 * ## What may live here
 *
 * A secret qualifies ONLY if it is read during a request that already has
 * `platform.env.DB` and has already resolved a session. That is what makes
 * a DB round-trip possible at the point of use.
 *
 * ## What may NOT, and why
 *
 * `BETTER_AUTH_SECRET` is deliberately excluded and must stay a Cloudflare
 * secret. Two independent reasons:
 *
 *  1. **Circular.** It is consumed in `authHook` (hooks.server.ts) to
 *     resolve the session on every request — before we know who the user
 *     is. Reading it from a table gated behind an authenticated admin page
 *     would require a session to fetch the secret that validates sessions.
 *
 *  2. **Privilege escalation.** It signs session cookies. Anything that can
 *     read it can mint a session for any user, including super_admin. A
 *     settings page that exposed it would turn "admin panel read" into
 *     "full account takeover".
 *
 * It is additionally the key-derivation root for encrypting everything in
 * this registry (see crypto.ts), so storing it beside the ciphertext it
 * protects would defeat the encryption entirely.
 *
 * `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` are likewise excluded:
 * they are deploy-time credentials used to create the Worker, so they
 * cannot live inside it.
 */

export type SecretDef = {
  /** Storage key, matching the env var name it overrides. */
  key: string;
  /** Human label for the admin form. */
  label: string;
  /** What it does and where to obtain it. */
  help: string;
  /**
   * Non-secret identifiers are shown in full rather than masked — masking
   * a value that is not confidential just makes it hard to verify.
   */
  sensitive: boolean;
  group: string;
};

export const MANAGED_SECRETS: readonly SecretDef[] = [
  {
    key: "BEAM_MERCHANT_ID",
    label: "Beam merchant ID",
    help: "REQUIRED. Beam authenticates with HTTP Basic auth as base64(merchantId:apiKey) — the merchant ID is the username, a separate credential from the API key. Without it every Beam request is rejected. Lighthouse dashboard → Developers.",
    // A public identifier, not a credential — shown in full so an admin
    // can verify it against the Lighthouse dashboard. Masking it would
    // only make a typo harder to spot.
    sensitive: false,
    group: "Payments — BeamCheckout",
  },
  {
    key: "BEAM_API_KEY",
    label: "Beam secret key",
    help: "Server-side API key used to create charges and issue refunds. Beam dashboard → Developers → API keys.",
    sensitive: true,
    group: "Payments — BeamCheckout",
  },
  {
    key: "BEAM_WEBHOOK_SECRET",
    label: "Beam webhook secret",
    help: "Verifies the HMAC signature on inbound Beam webhooks. Getting this wrong means paid orders are never confirmed.",
    sensitive: true,
    group: "Payments — BeamCheckout",
  },
  {
    key: "RESEND_API_KEY",
    label: "Resend API key",
    help: "Sends order receipts and abandoned-cart email. Leave unset to disable transactional email — the shop degrades quietly rather than failing.",
    sensitive: true,
    group: "Email — Resend",
  },
  {
    key: "LINE_NOTIFY_TOKEN",
    label: "LINE Notify token",
    help: "Pushes a LINE message to the operator on every new paid order (C4). Issue a personal access token at notify-bot.line.me → My page. Leave unset to disable the LINE channel — email notification (site settings) works independently.",
    sensitive: true,
    group: "Notifications — LINE",
  },
] as const;

const MANAGED_KEYS = new Set(MANAGED_SECRETS.map((s) => s.key));

/**
 * Guard for the write path. Without this, a crafted form POST could write
 * an arbitrary key into the secrets table — including one that shadows an
 * env var this registry deliberately refuses to manage.
 */
export function isManagedSecret(key: string): boolean {
  return MANAGED_KEYS.has(key);
}

/** Registry entries grouped for rendering, preserving declaration order. */
export function secretsByGroup(): Map<string, SecretDef[]> {
  const groups = new Map<string, SecretDef[]>();
  for (const def of MANAGED_SECRETS) {
    const list = groups.get(def.group);
    if (list) list.push(def);
    else groups.set(def.group, [def]);
  }
  return groups;
}

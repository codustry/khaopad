/**
 * Payment health for the admin (v4.6.0): is Beam configured, against
 * which environment, has a verified webhook ever arrived, and do the
 * credentials actually work. Each answer is something a merchant
 * otherwise only discovers when a customer can't pay — on bactrack.in.th
 * an undecryptable key and an unregistered webhook both went unnoticed
 * until a test purchase.
 */
import { BeamPaymentProvider } from "./beam";
import {
  diagnoseProviderConfig,
  resolveBeamProvider,
} from "./beam-config.server";

type HealthEnv = Parameters<typeof diagnoseProviderConfig>[0] & {
  CONTENT_CACHE?: KVNamespace;
};

const lastWebhookKey = (provider: string) => `shop:webhook:${provider}:lastAt`;

/**
 * Called by a webhook route after the signature verified. Best-effort:
 * bookkeeping must never fail a webhook.
 */
export async function recordWebhookReceived(
  env: { CONTENT_CACHE?: KVNamespace },
  provider: string,
  at = new Date(),
): Promise<void> {
  try {
    await env.CONTENT_CACHE?.put(lastWebhookKey(provider), at.toISOString());
  } catch {
    /* bookkeeping only */
  }
}

export type BeamMode = "live" | "playground" | "custom";

export function beamMode(baseUrl: string | undefined): BeamMode {
  if (!baseUrl || /^https:\/\/api\.beamcheckout\.com\/?$/.test(baseUrl)) {
    return "live";
  }
  if (/playground\.api\.beamcheckout\.com/.test(baseUrl)) return "playground";
  return "custom";
}

export type BeamHealth = {
  mode: BeamMode;
  apiBaseUrl: string;
  configured: boolean;
  missing: string[];
  undecryptable: string[];
  unread: string[];
  lastWebhookAt: string | null;
};

export async function getBeamHealth(env: HealthEnv): Promise<BeamHealth> {
  const [diagnosis, lastWebhookAt] = await Promise.all([
    diagnoseProviderConfig(env, "beam"),
    env.CONTENT_CACHE?.get(lastWebhookKey("beam")).catch(() => null) ??
      Promise.resolve(null),
  ]);
  const baseUrl =
    typeof env.BEAM_BASE_URL === "string" && env.BEAM_BASE_URL
      ? env.BEAM_BASE_URL
      : "https://api.beamcheckout.com";
  return {
    mode: beamMode(baseUrl),
    apiBaseUrl: baseUrl,
    configured:
      diagnosis.missing.length === 0 && diagnosis.undecryptable.length === 0,
    ...diagnosis,
    lastWebhookAt: lastWebhookAt ?? null,
  };
}

/** The admin's "test connection": one read-only authenticated call. */
export async function testBeamConnection(
  env: HealthEnv,
): Promise<{ ok: boolean; status: number; reason?: string }> {
  const provider = await resolveBeamProvider(env);
  if (!(provider instanceof BeamPaymentProvider)) {
    return { ok: false, status: 0, reason: "not_configured" };
  }
  return provider.checkConnection();
}

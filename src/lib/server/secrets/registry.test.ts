import { describe, it, expect } from "vitest";
import { MANAGED_SECRETS, isManagedSecret, secretsByGroup } from "./registry";

describe("managed secret registry", () => {
  it("never admits BETTER_AUTH_SECRET", () => {
    // Two independent reasons this must stay a Cloudflare secret:
    //  1. It is read in authHook BEFORE a session exists — storing it
    //     behind a session-gated admin page is circular.
    //  2. It signs session cookies, so read access = forge any login.
    // It is also the key-derivation root for encrypting this very table.
    expect(isManagedSecret("BETTER_AUTH_SECRET")).toBe(false);
    expect(MANAGED_SECRETS.some((s) => s.key === "BETTER_AUTH_SECRET")).toBe(
      false,
    );
  });

  it("never admits deploy-time Cloudflare credentials", () => {
    // These create the Worker, so they cannot live inside it.
    expect(isManagedSecret("CLOUDFLARE_API_TOKEN")).toBe(false);
    expect(isManagedSecret("CLOUDFLARE_ACCOUNT_ID")).toBe(false);
  });

  it("rejects arbitrary keys", () => {
    // The write path guards on this. Without it a crafted form POST could
    // write any key, including one shadowing a refused env var.
    expect(isManagedSecret("")).toBe(false);
    expect(isManagedSecret("DATABASE_URL")).toBe(false);
    expect(isManagedSecret("beam_api_key")).toBe(false); // case-sensitive
  });

  it("accepts exactly the intended keys", () => {
    const keys = MANAGED_SECRETS.map((s) => s.key).sort();
    expect(keys).toEqual([
      "BEAM_API_KEY",
      "BEAM_MERCHANT_ID",
      "BEAM_WEBHOOK_SECRET",
      "LINE_NOTIFY_TOKEN",
      "RESEND_API_KEY",
    ]);
  });

  it("includes BEAM_MERCHANT_ID — Beam requires it to authenticate", () => {
    // Beam uses HTTP Basic as base64(merchantId:apiKey), so the merchant
    // id is the username and a hard requirement, not decoration. I briefly
    // removed it after concluding from the code that nothing read it;
    // the code was wrong, not the requirement.
    expect(isManagedSecret("BEAM_MERCHANT_ID")).toBe(true);
  });

  it("marks credentials sensitive but the merchant identifier public", () => {
    // A wrong flag means a live key renders in full on the page. The
    // merchant id is a public identifier — masking it would only make a
    // typo harder to spot against the Lighthouse dashboard.
    for (const def of MANAGED_SECRETS) {
      const expected = def.key !== "BEAM_MERCHANT_ID";
      expect(def.sensitive, `${def.key}.sensitive`).toBe(expected);
    }
  });

  it("gives every entry a label, help text and group", () => {
    for (const def of MANAGED_SECRETS) {
      expect(def.label.length, `${def.key}.label`).toBeGreaterThan(0);
      expect(def.help.length, `${def.key}.help`).toBeGreaterThan(0);
      expect(def.group.length, `${def.key}.group`).toBeGreaterThan(0);
    }
  });

  it("groups without losing or duplicating entries", () => {
    const grouped = [...secretsByGroup().values()].flat();
    expect(grouped.length).toBe(MANAGED_SECRETS.length);
    expect(new Set(grouped.map((d) => d.key)).size).toBe(
      MANAGED_SECRETS.length,
    );
  });

  it("has no duplicate keys", () => {
    const keys = MANAGED_SECRETS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

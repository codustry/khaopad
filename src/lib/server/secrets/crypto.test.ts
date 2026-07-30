import { describe, it, expect } from "vitest";
import { encryptSecret, decryptSecret, maskSecret } from "./crypto";

const MASTER = "test-master-secret-do-not-use-in-production";

describe("secret encryption", () => {
  it("round-trips a value", async () => {
    const plaintext = "sk_live_abcdef1234567890";
    const encrypted = await encryptSecret(plaintext, MASTER);
    expect(await decryptSecret(encrypted, MASTER)).toBe(plaintext);
  });

  it("never stores the plaintext in the ciphertext", async () => {
    // The whole point of the feature. If this fails, a D1 dump leaks keys.
    const plaintext = "sk_live_abcdef1234567890";
    const encrypted = await encryptSecret(plaintext, MASTER);
    expect(encrypted).not.toContain(plaintext);
    expect(encrypted).not.toContain("abcdef");
  });

  it("uses a fresh IV per call, so equal plaintexts differ", async () => {
    // IV reuse under one key breaks BOTH confidentiality and authentication
    // in GCM. Identical ciphertexts would prove the IV is static.
    const a = await encryptSecret("same-value", MASTER);
    const b = await encryptSecret("same-value", MASTER);
    expect(a).not.toBe(b);
    expect(await decryptSecret(a, MASTER)).toBe("same-value");
    expect(await decryptSecret(b, MASTER)).toBe("same-value");
  });

  it("returns null for a different master secret", async () => {
    // The BETTER_AUTH_SECRET-rotated case. Must fail closed, not return
    // garbage that gets handed to a payment provider.
    const encrypted = await encryptSecret("value", MASTER);
    expect(await decryptSecret(encrypted, "a-different-secret")).toBeNull();
  });

  it("returns null for tampered ciphertext", async () => {
    // GCM is authenticated: a single flipped bit must fail the tag check.
    // Tamper at the byte level and re-encode, so this tests real tampering
    // rather than merely malformed base64 (which would pass vacuously).
    const encrypted = await encryptSecret("value", MASTER);
    const raw = Uint8Array.from(atob(encrypted.slice(3)), (c) =>
      c.charCodeAt(0),
    );
    raw[raw.length - 5] ^= 0x01;
    const tampered = "v1:" + btoa(String.fromCharCode(...raw));
    // Still structurally valid — proving the rejection is cryptographic.
    expect(atob(tampered.slice(3)).length).toBe(raw.length);
    expect(await decryptSecret(tampered, MASTER)).toBeNull();
  });

  it("returns null for an unprefixed (legacy/plaintext) value", async () => {
    expect(await decryptSecret("sk_live_raw_plaintext", MASTER)).toBeNull();
  });

  it("returns null for a truncated payload", async () => {
    expect(await decryptSecret("v1:AAAA", MASTER)).toBeNull();
  });

  it("refuses to encrypt without a master secret", async () => {
    await expect(encryptSecret("value", "")).rejects.toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("carries a version prefix so a future re-key can migrate", async () => {
    expect(await encryptSecret("value", MASTER)).toMatch(/^v1:/);
  });

  it("round-trips unicode and long values", async () => {
    const plaintext = "ключ-🔑-ทดสอบ-" + "x".repeat(500);
    const encrypted = await encryptSecret(plaintext, MASTER);
    expect(await decryptSecret(encrypted, MASTER)).toBe(plaintext);
  });
});

describe("maskSecret", () => {
  it("reveals only the last 4 characters", async () => {
    expect(maskSecret("sk_live_abcdef1234")).toBe("••••••••1234");
  });

  it("fully masks short values", async () => {
    // Revealing 4 of 6 characters is worse than revealing none.
    expect(maskSecret("short")).toBe("••••••••");
    expect(maskSecret("12345678")).toBe("••••••••");
  });

  it("never returns the input for a sensitive-length value", async () => {
    const secret = "sk_live_verysecretvalue";
    expect(maskSecret(secret)).not.toBe(secret);
    expect(maskSecret(secret).length).toBeLessThan(secret.length);
  });
});

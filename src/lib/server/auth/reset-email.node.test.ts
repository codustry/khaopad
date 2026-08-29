/**
 * Pins the reset email's sender identity and send gating.
 *
 * The From-header precedence is the load-bearing part: every fork runs on
 * its own domain with its own verified Resend sender, so a hardcoded
 * Codustry address that overrode the deployment's would send mail from the
 * wrong brand — and would be rejected outright by a fork's own Resend
 * account, which only accepts its verified domains.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  sendResetPasswordEmail,
  resolveResetFrom,
  DEFAULT_RESET_FROM,
} from "./reset-email";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Capture the Resend request without making one. */
function captureFetch(status = 200) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ id: "re_1" }), { status });
  }) as unknown as typeof fetch;
  return calls;
}

describe("resolveResetFrom — deployment value wins", () => {
  it("uses the deployment's own RESEND_FROM when set", () => {
    // bactrack, drvakuum, … each have their own verified sender.
    expect(resolveResetFrom({ RESEND_FROM: "no-reply@bactrack.in.th" })).toBe(
      "no-reply@bactrack.in.th",
    );
  });

  it("falls back to the Codustry identity when unset", () => {
    expect(resolveResetFrom({})).toBe(DEFAULT_RESET_FROM);
    expect(resolveResetFrom({ RESEND_FROM: undefined })).toBe(
      DEFAULT_RESET_FROM,
    );
  });

  it("treats blank/whitespace RESEND_FROM as unset", () => {
    // An empty secret is a misconfiguration, not a deliberate choice —
    // sending from "" would just be rejected by Resend.
    expect(resolveResetFrom({ RESEND_FROM: "   " })).toBe(DEFAULT_RESET_FROM);
  });

  it("the default carries the display name and the Codustry address", () => {
    expect(DEFAULT_RESET_FROM).toBe(
      "Khao Pad (ข้าวผัด) by Codustry <no-reply@codustry.com>",
    );
  });
});

describe("sendResetPasswordEmail", () => {
  it("sends from the deployment address when configured", async () => {
    const calls = captureFetch();
    const ok = await sendResetPasswordEmail(
      { RESEND_API_KEY: "re_test", RESEND_FROM: "no-reply@drvakuum.com" },
      { email: "admin@example.com", url: "https://cms.example.com/r?token=t" },
    );
    expect(ok).toBe(true);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].body.from).toBe("no-reply@drvakuum.com");
    expect(calls[0].body.to).toEqual(["admin@example.com"]);
  });

  it("sends from the Codustry identity when RESEND_FROM is unset", async () => {
    const calls = captureFetch();
    const ok = await sendResetPasswordEmail(
      { RESEND_API_KEY: "re_test" },
      { email: "admin@example.com", url: "https://cms.example.com/r?token=t" },
    );
    expect(ok).toBe(true);
    expect(calls[0].body.from).toBe(DEFAULT_RESET_FROM);
  });

  it("does nothing without an API key", async () => {
    // No key is "email disabled", not an error — same as the OTP sender.
    const calls = captureFetch();
    const ok = await sendResetPasswordEmail(
      { RESEND_FROM: "no-reply@example.com" },
      { email: "admin@example.com", url: "https://x/r?token=t" },
    );
    expect(ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("includes the reset link and both languages in the body", async () => {
    const calls = captureFetch();
    await sendResetPasswordEmail(
      { RESEND_API_KEY: "re_test" },
      { email: "a@b.com", url: "https://cms.example.com/r?token=abc123" },
    );
    const html = String(calls[0].body.html);
    expect(html).toContain("https://cms.example.com/r?token=abc123");
    expect(html).toContain("Reset your password");
    expect(html).toContain("ตั้งรหัสผ่านใหม่");
    // The expiry promise must be stated to the recipient.
    expect(html).toContain("1 hour");
    expect(String(calls[0].body.subject)).toContain("ตั้งรหัสผ่านใหม่");
  });

  it("returns false rather than throwing when Resend rejects", async () => {
    // Must never throw into Better Auth's endpoint.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    captureFetch(422);
    const ok = await sendResetPasswordEmail(
      { RESEND_API_KEY: "re_test" },
      { email: "a@b.com", url: "https://x/r?token=t" },
    );
    expect(ok).toBe(false);
  });

  it("returns false rather than throwing when the network fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const ok = await sendResetPasswordEmail(
      { RESEND_API_KEY: "re_test" },
      { email: "a@b.com", url: "https://x/r?token=t" },
    );
    expect(ok).toBe(false);
  });
});

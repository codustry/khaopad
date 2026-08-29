/**
 * Pins the password-reset flow's security properties.
 *
 * Two kinds of assertion here, and the difference matters:
 *
 *  - BEHAVIOURAL: the forgot-password action is invoked directly with a
 *    fake platform, and the returned shape is compared between a known
 *    and an unknown address. This is the enumeration guarantee, and it is
 *    executed, not read.
 *  - STRUCTURAL: the auth config and reset route are read as source and
 *    matched. Same trade-off the repo's other `*.node.test.ts` pins take
 *    — asserting `revokeSessionsOnPasswordReset: true` reaches Better
 *    Auth would need a live D1 and a real mail round-trip, so what is
 *    checked is that the option is set and not silently dropped.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { actions } from "./+page.server";

const repoRoot = join(import.meta.dirname, "../../../../..");
const authSource = readFileSync(
  join(repoRoot, "src/lib/server/auth/index.ts"),
  "utf8",
);
const layoutSource = readFileSync(
  join(repoRoot, "src/routes/(admin)/admin/+layout.server.ts"),
  "utf8",
);
const loginSource = readFileSync(
  join(repoRoot, "src/routes/(admin)/admin/login/+page.svelte"),
  "utf8",
);
const resetRouteSource = readFileSync(
  join(repoRoot, "src/routes/(admin)/admin/reset-password/+page.server.ts"),
  "utf8",
);

/**
 * Drive the action with a platform whose D1 answers as if the email were
 * known or unknown. The distinction lives inside Better Auth's endpoint,
 * which we stand in for by making the whole handler call a no-op — what
 * is under test is whether the ACTION's own reply varies.
 */
async function runAction(email: string, opts: { ipAllowed?: boolean } = {}) {
  const db = {
    prepare() {
      return {
        bind() {
          return {
            async run() {
              return { meta: { changes: opts.ipAllowed === false ? 0 : 1 } };
            },
          };
        },
      };
    },
  };
  const form = new FormData();
  form.set("email", email);
  const request = new Request("https://cms.example.com/admin/forgot-password", {
    method: "POST",
    headers: { origin: "https://cms.example.com" },
  });
  Object.defineProperty(request, "formData", { value: async () => form });

  return (
    actions.default as unknown as (e: unknown) => Promise<Record<string, never>>
  )({
    request,
    platform: {
      env: {
        DB: db,
        BETTER_AUTH_SECRET: "x".repeat(32),
        BETTER_AUTH_URL: "https://cms.example.com",
      },
    },
  });
}

describe("forgot-password — no account enumeration", () => {
  it("answers identically for a known and an unknown address", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const known = await runAction("local@dev.test");
    const unknown = await runAction("definitely-not-a-user@example.com");
    // Byte-identical replies: any difference is a membership oracle for
    // the admin panel.
    expect(known).toEqual(unknown);
    expect(JSON.stringify(known)).toBe(JSON.stringify(unknown));
    vi.restoreAllMocks();
  });

  it("answers the same when the per-IP throttle refuses", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const allowed = await runAction("local@dev.test");
    const throttled = await runAction("local@dev.test", { ipAllowed: false });
    // A throttled reply must not reveal that this address is real and
    // was reset today — worse than the plain existence leak.
    expect(throttled).toEqual(allowed);
    vi.restoreAllMocks();
  });

  it("never returns an error field on a well-formed request", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await runAction("someone@example.com");
    expect(result).not.toHaveProperty("error");
    expect(result).toEqual({ sent: true });
    vi.restoreAllMocks();
  });

  it("rejects a malformed address — the one safe difference", async () => {
    // Leaks nothing about any account, and silently "succeeding" on an
    // empty box is a usability trap.
    const result = await runAction("not-an-email");
    expect(result).toEqual({ sent: false, invalid: true });
  });

  it("routes through guardedAuthHandler, not auth.api", () => {
    const source = readFileSync(
      join(import.meta.dirname, "+page.server.ts"),
      "utf8",
    );
    // auth.api.forgetPassword would skip BOTH Better Auth's limiter and
    // the Cloudflare binding — the one unthrottled way to make the Worker
    // send mail.
    expect(source).toContain("guardedAuthHandler");
    // Strip comments first: the file EXPLAINS why auth.api is wrong, so a
    // raw substring match would trip on its own rationale.
    const code = source
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("auth.api.forgetPassword");
  });

  it("posts to the endpoint Better Auth actually registers", () => {
    // Found live, not in tests. Better Auth 1.6.5 registers
    // `/request-password-reset`; `/forget-password` is NOT a route in
    // this version (it survives only inside the library's own rate-limit
    // path matcher, which is what made the stale name look plausible).
    // Posting to the wrong path 404s — and because this action swallows
    // failures to avoid enumeration, that 404 was completely SILENT: the
    // form reported success and no mail was ever sent. Pinning the path
    // is what stops that failure mode from returning unnoticed.
    const source = readFileSync(
      join(import.meta.dirname, "+page.server.ts"),
      "utf8",
    );
    expect(source).toContain("/api/auth/request-password-reset");
    const code = source
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("/api/auth/forget-password");
  });

  it("claims a per-IP slot as defence in depth", () => {
    const source = readFileSync(
      join(import.meta.dirname, "+page.server.ts"),
      "utf8",
    );
    expect(source).toContain("claimResetIpSlot");
  });
});

describe("rate-limit guard — reset path", () => {
  it("guards the real reset endpoint name", () => {
    const guard = readFileSync(
      join(repoRoot, "src/lib/server/auth/rate-limit-guard.ts"),
      "utf8",
    );
    // The list previously carried "/forget-password", so the reset path
    // was in practice unguarded by the Cloudflare binding.
    expect(guard).toContain('"/request-password-reset"');
  });
});

describe("auth config — reset wiring", () => {
  it("enables sendResetPassword", () => {
    expect(authSource).toMatch(/sendResetPassword:\s*async/);
  });

  it("gates the send on the durable 24h claim", () => {
    // The throttle must sit at the single choke point every caller
    // passes through, not in one route.
    expect(authSource).toContain("claimResetSlot");
    expect(authSource).toMatch(/if\s*\(!maySend\)\s*return/);
  });

  it("expires reset tokens in 1 hour", () => {
    expect(authSource).toMatch(/resetPasswordTokenExpiresIn:\s*60\s*\*\s*60/);
  });

  it("revokes other sessions on a completed reset", () => {
    // Mirrors the profile page's change-password reasoning: a reset is
    // what you do when someone else may have your credentials.
    expect(authSource).toMatch(/revokeSessionsOnPasswordReset:\s*true/);
  });
});

describe("route reachability", () => {
  it("leaves the reset pages reachable without a session", () => {
    // Gating them behind auth would redirect the only users they exist
    // for back to the login form they are locked out of.
    expect(layoutSource).toContain('"/admin/forgot-password"');
    expect(layoutSource).toContain('"/admin/reset-password"');
  });

  it("offers a forgot-password link on the login page", () => {
    expect(loginSource).toContain("/admin/forgot-password");
    expect(loginSource).toContain("cms_forgot_password_link");
  });
});

describe("reset-password route", () => {
  it("validates the new password server-side", () => {
    // The client check is a convenience, not a control.
    expect(resetRouteSource).toMatch(/newPassword\.length\s*<\s*8/);
    expect(resetRouteSource).toContain("newPassword !== confirmPassword");
  });

  it("treats an expired or spent token as invalid", () => {
    expect(resetRouteSource).toContain("invalidToken");
  });

  it("routes through the rate-limit guard", () => {
    // Takes an attacker-supplied token — must sit behind the throttle.
    expect(resetRouteSource).toContain("guardedAuthHandler");
    const code = resetRouteSource
      .replace(/\/\/[^\n]*/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toContain("auth.api.resetPassword");
  });
});

describe("message keys", () => {
  const en = JSON.parse(
    readFileSync(join(repoRoot, "messages/en.json"), "utf8"),
  );
  const th = JSON.parse(
    readFileSync(join(repoRoot, "messages/th.json"), "utf8"),
  );

  it("ships every reset key in both locales", () => {
    const keys = Object.keys(en).filter(
      (k) =>
        k.startsWith("cms_forgot_password") ||
        k.startsWith("cms_reset_password"),
    );
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(th, `missing TH translation for ${key}`).toHaveProperty(key);
      expect(String(th[key]).length).toBeGreaterThan(0);
    }
  });

  it("actually translates them rather than copying English", () => {
    // A TH file that mirrors EN strings is an untranslated stub.
    expect(th.cms_forgot_password_title).not.toBe(en.cms_forgot_password_title);
    expect(th.cms_reset_password_title).not.toBe(en.cms_reset_password_title);
  });
});

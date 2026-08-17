import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Guards the self-service profile page.
 *
 * ## The bug this fixes
 *
 * Nobody could change a password through any UI, ever. `/admin/users`
 * offers only role changes, deletion and invitations, and it is gated to
 * `super_admin | admin` — so editors and authors could not reach even
 * that. Delete-and-reinvite was the only recovery, and the `authorId`
 * foreign key blocks the delete once a user has written an article.
 *
 * ## Why these are source assertions
 *
 * Same reason as `sidebar-nav.node.test.ts` and
 * `auth/cookie-name.node.test.ts`: the tests run in the node environment
 * with no jsdom and no Svelte-aware resolution, and exercising these
 * actions for real would need a live D1 binding plus a Better Auth
 * instance. The properties worth pinning are configuration-shaped —
 * which options are passed, which fields are absent — and that is
 * exactly what the source carries.
 */
const SERVER_SRC = new URL("./+page.server.ts", import.meta.url).pathname;
const PAGE_SRC = new URL("./+page.svelte", import.meta.url).pathname;
const NAV_SRC = new URL(
  "../../../../lib/components/admin/sidebar-nav.ts",
  import.meta.url,
).pathname;
const AUTH_SRC = new URL(
  "../../../../lib/server/auth/index.ts",
  import.meta.url,
).pathname;
const SIDEBAR_SRC = new URL(
  "../../../../lib/components/admin/Sidebar.svelte",
  import.meta.url,
).pathname;

const server = readFileSync(SERVER_SRC, "utf8");
const page = readFileSync(PAGE_SRC, "utf8");
const nav = readFileSync(NAV_SRC, "utf8");
const auth = readFileSync(AUTH_SRC, "utf8");
const sidebar = readFileSync(SIDEBAR_SRC, "utf8");

/** The body of the `changePassword` action, up to the next action. */
const changePasswordAction = (() => {
  const start = server.indexOf("changePassword: async");
  const end = server.indexOf("updateProfile: async");
  return server.slice(start, end === -1 ? undefined : end);
})();

/** The body of the `updateProfile` action. */
const updateProfileAction = server.slice(
  server.indexOf("updateProfile: async"),
);

describe("profile page — password change", () => {
  it("exposes a changePassword form action", () => {
    expect(server).toMatch(/changePassword: async/);
    expect(page).toMatch(/action="\?\/changePassword"/);
  });

  it("delegates verification to Better Auth's changePassword", () => {
    // Better Auth checks `currentPassword` against the stored hash. A
    // hand-rolled comparison here would be the place a bypass creeps in.
    expect(changePasswordAction).toMatch(/auth\.api\.changePassword\(/);
    expect(changePasswordAction).toMatch(/currentPassword/);
    expect(changePasswordAction).toMatch(/newPassword/);
  });

  it("passes revokeOtherSessions: true", () => {
    // The whole point: a password change made because credentials leaked
    // must not leave the attacker's other sessions alive.
    expect(changePasswordAction).toMatch(/revokeOtherSessions:\s*true/);
  });

  it("re-checks the confirmation server-side", () => {
    // The page also checks this, but a client-side check is a
    // convenience, never a control.
    expect(changePasswordAction).toMatch(/newPassword\s*!==\s*confirmPassword/);
  });

  it("uses a form action, not a browser fetch to /api/auth", () => {
    // Form actions get SvelteKit's origin check for free. The login page
    // fetches the endpoint directly only because it is pre-session.
    expect(page).not.toMatch(/fetch\(\s*['"`]\/api\/auth/);
    expect(page).toMatch(/method="POST"/);
  });
});

describe("profile page — audit logging", () => {
  it("records the password change", () => {
    expect(changePasswordAction).toMatch(/logAudit\(/);
    expect(changePasswordAction).toMatch(/user\.password_change/);
  });

  it("puts no password material in the audit metadata", () => {
    // The metadata object passed to logAudit, i.e. everything after the
    // entity id argument.
    const logCall = changePasswordAction.slice(
      changePasswordAction.indexOf("logAudit("),
    );
    const metadata = logCall.slice(
      logCall.indexOf("{"),
      logCall.indexOf("}") + 1,
    );
    // Not the password, not its length, not a prefix or hash of it.
    expect(metadata).not.toMatch(/password/i);
    expect(metadata).not.toMatch(/\.length/);
  });
});

describe("profile page — updateProfile", () => {
  it("accepts name and image", () => {
    expect(updateProfileAction).toMatch(/form\.get\("name"\)/);
    expect(updateProfileAction).toMatch(/form\.get\("image"\)/);
    expect(updateProfileAction).toMatch(/updatedAt/);
  });

  it("does NOT let a user change their own email", () => {
    // Changing an email under Better Auth needs `changeEmail` plus
    // verification mail, and transactional email is optional in this
    // deployment (RESEND_API_KEY may be unset). Accepting an email here
    // would either hard-require Resend or land an unverified address.
    expect(updateProfileAction).not.toMatch(/form\.get\("email"\)/);
    expect(updateProfileAction).not.toMatch(/email:/);
    expect(updateProfileAction).not.toMatch(/changeEmail/);
  });

  it("renders the email field as read-only", () => {
    const emailField = page.slice(
      page.indexOf('id="email"'),
      page.indexOf('id="email"') + 300,
    );
    expect(emailField).toMatch(/readonly/);
    // No `name` attribute — a disabled input still submits if named.
    expect(emailField).not.toMatch(/name="email"/);
  });
});

describe("profile nav entry", () => {
  /** The nav item object for /admin/profile. */
  const entry = (() => {
    const idx = nav.indexOf('href: "/admin/profile"');
    if (idx === -1) return "";
    // Back up to the start of the object literal, forward to its end.
    const start = nav.lastIndexOf("{", idx);
    const end = nav.indexOf("},", idx);
    return nav.slice(start, end);
  })();

  it("registers a /admin/profile nav item", () => {
    expect(entry).not.toBe("");
    expect(entry).toMatch(/label: m\.cms_profile/);
  });

  it("has NO roles restriction", () => {
    // This is the regression that matters. An author is the weakest
    // staff role and cannot reach /admin/users at all — if this entry
    // grows a `roles` array, authors lose the only way to change their
    // own password and the original bug is back for them.
    expect(entry).not.toMatch(/roles:/);
  });

  it("is linked from the sidebar user chip", () => {
    // The chip is where people look for "my account"; without the link
    // the page exists but is undiscoverable.
    expect(sidebar).toMatch(/admin\/profile/);
  });
});

describe("auth rate limiting", () => {
  it("enables Better Auth's rate limiter", () => {
    // Off by default upstream, and nothing else in this codebase limits
    // auth attempts. The `currentPassword` field is an online guessing
    // oracle without it.
    expect(auth).toMatch(/rateLimit:\s*\{\s*enabled:\s*true/);
  });
});

describe("i18n", () => {
  it("defines every new message key in both locales", () => {
    const en = JSON.parse(
      readFileSync(
        new URL("../../../../../messages/en.json", import.meta.url).pathname,
        "utf8",
      ),
    ) as Record<string, string>;
    const th = JSON.parse(
      readFileSync(
        new URL("../../../../../messages/th.json", import.meta.url).pathname,
        "utf8",
      ),
    ) as Record<string, string>;

    const keys = [
      "cms_profile",
      "cms_profile_help",
      "cms_profile_name",
      "cms_profile_email",
      "cms_password",
      "cms_password_current",
      "cms_password_new",
      "cms_password_confirm",
      "cms_password_changed",
    ];
    for (const key of keys) {
      expect(en[key], `en.json missing ${key}`).toBeTruthy();
      expect(th[key], `th.json missing ${key}`).toBeTruthy();
      // A copied English string is an untranslated string.
      expect(th[key], `th.json ${key} not translated`).not.toBe(en[key]);
    }
  });
});

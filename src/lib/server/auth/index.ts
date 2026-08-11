import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { emailOTP } from "better-auth/plugins";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../content/schema";
import { sendSignInOtpEmail } from "./otp-email";

/**
 * D1 + Better Auth date binding workaround.
 *
 * Better Auth's adapter factory passes JS Date objects directly to the
 * Drizzle driver for any field declared as `type: "date"` (e.g.
 * `createdAt`, `updatedAt`, `expiresAt`). Cloudflare D1's binding layer
 * only accepts string / number / boolean / null / Uint8Array — it rejects
 * Date with `D1_TYPE_ERROR: Type 'object' not supported`.
 *
 * `databaseHooks` won't help here because the transform layer runs AFTER
 * hooks and converts ISO strings back to Date objects (see
 * @better-auth/core/db/adapter/factory.mjs `transformInput`).
 *
 * The fix: proxy the D1 database so `prepare(sql).bind(...args)` swaps
 * any Date in `args` for its ISO string form before Cloudflare sees it.
 * Same effect for `D1PreparedStatement.bind`.
 */
function wrapD1ForDates(d1: D1Database): D1Database {
  const coerce = (v: unknown): unknown =>
    v instanceof Date ? v.toISOString() : v;

  return new Proxy(d1, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "prepare" || typeof original !== "function") return original;
      return (sql: string) => {
        const stmt = original.call(target, sql);
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp) {
            const inner = Reflect.get(stmtTarget, stmtProp);
            if (stmtProp !== "bind" || typeof inner !== "function")
              return inner;
            return (...args: unknown[]) =>
              inner.call(stmtTarget, ...args.map(coerce));
          },
        });
      };
    },
  });
}

export function createAuth(
  d1: D1Database,
  env: {
    BETTER_AUTH_SECRET: string;
    BETTER_AUTH_URL: string;
    /** Optional Resend credentials — enable customer OTP sign-in mail. */
    RESEND_API_KEY?: string;
    RESEND_FROM?: string;
  },
) {
  const db = drizzle(wrapD1ForDates(d1), { schema });

  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",
      // Better Auth's adapter looks for singular model names ("user",
      // "session", "account", "verification"). Our Drizzle schema uses
      // plural names. Pass the schema explicitly and map the names.
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    basePath: "/api/auth",
    emailAndPassword: { enabled: true },
    session: {
      expiresIn: 60 * 60 * 24 * 7, // 7 days
      updateAge: 60 * 60 * 24, // refresh daily
    },
    user: {
      additionalFields: {
        role: { type: "string", defaultValue: "author", input: false },
      },
    },
    /**
     * Customer role assignment (v3.17 D1).
     *
     * The email-OTP sign-in auto-creates a user row for unknown emails.
     * Without this hook that row would inherit the `author` default —
     * an ADMIN role (authors can enter /admin and write articles). The
     * create-path hook keys off the endpoint that triggered the insert:
     * only `/sign-in/email-otp` (the customer flow) mints `customer`;
     * every admin path (invite signup, bootstrap signup, admin-created
     * users) keeps the `author` default and its explicit role writes.
     */
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (ctx?.path === "/sign-in/email-otp") {
              return { data: { ...user, role: "customer" } };
            }
            return { data: user };
          },
        },
      },
    },
    plugins: [
      /**
       * Passwordless customer sign-in (v3.17 D1): a 6-digit code sent
       * over the same Resend path as order receipts. Codes are stored
       * hashed (a leaked verifications table must not be a login
       * table), expire in 5 minutes, allow 3 attempts. The send is
       * fire-and-forget from Better Auth's perspective; a missing
       * Resend config makes sign-in impossible but never 500s.
       */
      emailOTP({
        otpLength: 6,
        expiresIn: 300,
        allowedAttempts: 3,
        storeOTP: "hashed",
        async sendVerificationOTP({ email, otp, type }) {
          if (type !== "sign-in") return; // only the customer flow sends mail
          await sendSignInOtpEmail(
            {
              RESEND_API_KEY: env.RESEND_API_KEY,
              RESEND_FROM: env.RESEND_FROM,
              DB: d1,
            },
            { email, otp },
          );
        },
      }),
    ],
    advanced: {
      /**
       * Session cookie name — deliberately WITHOUT a `__Host-` prefix.
       *
       * ## Why not `__Host-` (issue #120)
       *
       * Better Auth composes the final name as an unconditional
       * concatenation (`cookies/index.mjs`):
       *
       *     name: `${secureCookiePrefix}${name}`
       *
       * where `secureCookiePrefix` is `"__Secure-"` in production. It does
       * not check whether the configured name already carries a prefix, so
       * `"__Host-khaopad_session"` shipped as
       * `__Secure-__Host-khaopad_session`.
       *
       * Per RFC 6265bis §4.1.3.2 a prefix only carries its guarantees when
       * it is the LEADING prefix. With `__Secure-` in front, `__Host-`
       * becomes an ordinary part of the name and browsers enforce nothing.
       * Verified on the deployed demo: a cookie named
       * `__Secure-__Host-probe` was accepted WITH a `Domain` attribute,
       * while a correctly-named `__Host-probe` with `Domain` was refused.
       *
       * So the old config bought no subdomain protection while looking
       * like it did — the worst of both.
       *
       * ## What we do instead
       *
       * Let Better Auth own the prefix. It emits `__Secure-khaopad_session`
       * in production, which browsers DO enforce (Secure-only transport).
       *
       * The attributes below then supply `__Host-`-equivalent hardening
       * ourselves: `path: "/"` and no `Domain` (crossSubDomainCookies stays
       * disabled, so Better Auth never sets one). The only thing not
       * browser-enforced is the "no subdomain may overwrite this name"
       * guarantee — which matters solely if this deployment ever gains
       * sibling subdomains on the registrable domain.
       *
       * Getting real `__Host-` enforcement needs an upstream Better Auth
       * change (skip the prefix when the name already has one), or writing
       * the Set-Cookie header by hand. Tracked in #120.
       */
      cookies: {
        session_token: {
          name: "khaopad_session",
          attributes: {
            // Explicit rather than relying on defaults: these ARE the
            // __Host- requirements, and a future default change should
            // not silently relax them.
            path: "/",
            httpOnly: true,
            sameSite: "lax",
            // `secure` is derived by Better Auth from the environment, so
            // it stays true in production and false on http://localhost —
            // hardcoding it would break local dev sign-in.
          },
        },
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../content/schema";

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
  const coerce = (v: unknown): unknown => (v instanceof Date ? v.toISOString() : v);

  return new Proxy(d1, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "prepare" || typeof original !== "function") return original;
      return (sql: string) => {
        const stmt = original.call(target, sql);
        return new Proxy(stmt, {
          get(stmtTarget, stmtProp) {
            const inner = Reflect.get(stmtTarget, stmtProp);
            if (stmtProp !== "bind" || typeof inner !== "function") return inner;
            return (...args: unknown[]) => inner.call(stmtTarget, ...args.map(coerce));
          },
        });
      };
    },
  });
}

export function createAuth(
  d1: D1Database,
  env: { BETTER_AUTH_SECRET: string; BETTER_AUTH_URL: string },
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
  });
}

export type Auth = ReturnType<typeof createAuth>;

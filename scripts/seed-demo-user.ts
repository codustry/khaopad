/**
 * Demo-account seed.
 *
 * Creates a signed-in-able account for the public demo, so the
 * credentials the README documents actually work.
 *
 * ## Why this needs a script at all
 *
 * Better Auth stores an scrypt hash in `accounts.password`, with its own
 * salt format (`<salt-hex>:<key-hex>`) and its own KDF parameters. A
 * hand-written INSERT with a bcrypt/argon hash, or scrypt with guessed
 * parameters, produces a row that looks correct and fails every login.
 *
 * So this imports **Better Auth's own `hashPassword`** rather than
 * reimplementing it, then calls its `verifyPassword` on the result
 * before writing — if the hash wouldn't authenticate, the script fails
 * loudly instead of seeding a broken account.
 *
 * ## Usage
 *
 *   pnpm tsx scripts/seed-demo-user.ts                    # local D1
 *   pnpm tsx scripts/seed-demo-user.ts --remote
 *   DEMO_PASSWORD='…' pnpm tsx scripts/seed-demo-user.ts
 *
 * Idempotent: re-running resets the password and role rather than
 * creating a second account.
 *
 * ## Role
 *
 * `editor` by default, deliberately. A public demo account must not be
 * able to change roles, delete users, edit site settings, or define
 * content types — an `admin` demo account is a defacement waiting to
 * happen. Override with `--role` only for a private instance.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
// Better Auth's own KDF, via its published `./crypto` entry point.
// Importing this rather than reimplementing scrypt is the whole point:
// the salt format and KDF parameters stay whatever the library uses, so
// a version bump can't silently desync the seed from the login path.
import { hashPassword, verifyPassword } from "better-auth/crypto";

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const flag = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const email = flag("email", process.env.DEMO_EMAIL ?? "demo@khaopad.dev");
const password = flag(
  "password",
  process.env.DEMO_PASSWORD ?? "KhaoPadDemo!2026",
);
const name = flag("name", "Demo Editor");
const role = flag("role", "editor");
const dbName =
  process.env.D1_DB_NAME ?? (remote ? "khaopad-db-staging" : "khaopad-db");

const VALID_ROLES = ["super_admin", "admin", "editor", "author"];
if (!VALID_ROLES.includes(role)) {
  console.error(`Invalid role "${role}" — one of: ${VALID_ROLES.join(", ")}`);
  process.exit(1);
}
if (role === "super_admin" || role === "admin") {
  console.warn(
    `⚠  Creating a PUBLIC demo account with role "${role}". It will be able ` +
      `to change roles, delete content and edit settings. Use "editor" ` +
      `unless this instance is private.`,
  );
}

/** execFileSync with an argument array — never a shell string. */
function query<T = Record<string, unknown>>(sql: string): T[] {
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      dbName,
      remote ? "--remote" : "--local",
      "--json",
      "--command",
      sql,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  // wrangler prints warnings before the JSON payload.
  const parsed = JSON.parse(out.slice(out.indexOf("[")));
  return (parsed[0]?.results ?? []) as T[];
}

/** SQLite string literal — doubles embedded single quotes. */
const lit = (v: string | null): string =>
  v === null ? "NULL" : `'${v.replace(/'/g, "''")}'`;

const now = new Date().toISOString();

// ── Hash with Better Auth's own KDF, then prove it authenticates.
const hash = await hashPassword(password);
const ok = await verifyPassword({ hash, password });
if (!ok) {
  console.error(
    "Refusing to seed: the generated hash did not verify against its own " +
      "password. Better Auth's hashing may have changed — do not write this.",
  );
  process.exit(1);
}

console.log(`Seeding demo account → ${dbName}`);
console.log(`  email: ${email}`);
console.log(`  role:  ${role}`);

const existing = query<{ id: string }>(
  `SELECT id FROM users WHERE email = ${lit(email)} LIMIT 1`,
);

let userId: string;
if (existing.length > 0) {
  userId = existing[0].id;
  query(
    `UPDATE users SET name = ${lit(name)}, role = ${lit(role)},
       email_verified = 1, updated_at = ${lit(now)}
     WHERE id = ${lit(userId)}`,
  );
  console.log(`  ✓ updated existing user ${userId}`);
} else {
  userId = randomUUID();
  query(
    `INSERT INTO users (id, name, email, email_verified, image, role, created_at, updated_at)
     VALUES (${lit(userId)}, ${lit(name)}, ${lit(email)}, 1, NULL, ${lit(role)},
             ${lit(now)}, ${lit(now)})`,
  );
  console.log(`  ✓ created user ${userId}`);
}

// Better Auth looks up the credential account by (providerId, accountId).
// For email/password, providerId is 'credential' and accountId is the
// user id — matching what the sign-up flow writes.
const account = query<{ id: string }>(
  `SELECT id FROM accounts
   WHERE user_id = ${lit(userId)} AND provider_id = 'credential' LIMIT 1`,
);

if (account.length > 0) {
  query(
    `UPDATE accounts SET password = ${lit(hash)}, updated_at = ${lit(now)}
     WHERE id = ${lit(account[0].id)}`,
  );
  console.log("  ✓ reset password on existing credential account");
} else {
  query(
    `INSERT INTO accounts (id, user_id, account_id, provider_id, password, created_at, updated_at)
     VALUES (${lit(randomUUID())}, ${lit(userId)}, ${lit(userId)},
             'credential', ${lit(hash)}, ${lit(now)}, ${lit(now)})`,
  );
  console.log("  ✓ created credential account");
}

// ── Read the stored hash back and verify it, so a quoting or truncation
// bug in the INSERT surfaces here rather than at someone's first login.
const stored = query<{ password: string | null }>(
  `SELECT password FROM accounts
   WHERE user_id = ${lit(userId)} AND provider_id = 'credential' LIMIT 1`,
);
const storedHash = stored[0]?.password;
if (!storedHash) {
  console.error("✘ No password stored after write — aborting.");
  process.exit(1);
}
if (!(await verifyPassword({ hash: storedHash, password }))) {
  console.error(
    "✘ The hash READ BACK from the database does not verify. The account " +
      "would not be able to sign in.",
  );
  process.exit(1);
}

console.log(
  `\n✓ Verified: the stored hash authenticates "${password}".\n` +
    `  Sign in at /admin/login with ${email}`,
);

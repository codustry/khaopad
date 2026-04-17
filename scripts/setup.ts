/**
 * One-shot Cloudflare provisioning helper.
 *
 * Khao Pad is a *template*: each fork gets its own D1 database, R2 bucket, and
 * KV namespace. Cloudflare does NOT auto-create these for you — they must be
 * provisioned once per project and their IDs pasted into `wrangler.toml`.
 *
 * This script runs the three `wrangler` commands and prints the IDs you need
 * to copy into `wrangler.toml`:
 *
 *   wrangler d1 create <db-name>         -> database_id
 *   wrangler r2 bucket create <bucket>   -> (no ID — bucket name is the key)
 *   wrangler kv namespace create <name>  -> id
 *
 * Usage:
 *   pnpm setup                # uses defaults (khaopad-db, khaopad-media, CONTENT_CACHE)
 *   pnpm setup -- --db=foo --bucket=bar --kv=BAZ
 *
 * Prerequisites:
 *   - `wrangler login` (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID env).
 *
 * After it finishes: open `wrangler.toml`, replace the `LOCAL_DB_ID` and
 * `LOCAL_KV_ID` placeholders, then run `pnpm db:migrate` and `pnpm db:seed`.
 */
import { execSync } from "node:child_process";

type Args = { db: string; bucket: string; kv: string };

function parseArgs(): Args {
  const args: Args = {
    db: "khaopad-db",
    bucket: "khaopad-media",
    kv: "CONTENT_CACHE",
  };
  for (const arg of process.argv.slice(2)) {
    const [key, val] = arg.replace(/^--/, "").split("=");
    if (key === "db" && val) args.db = val;
    if (key === "bucket" && val) args.bucket = val;
    if (key === "kv" && val) args.kv = val;
  }
  return args;
}

function run(label: string, cmd: string): string {
  console.log(`\n──── ${label} ────`);
  console.log(`$ ${cmd}`);
  try {
    const out = execSync(cmd, { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] });
    process.stdout.write(out);
    return out;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`  (step failed or resource exists — continuing): ${msg.split("\n")[0]}`);
    return "";
  }
}

const args = parseArgs();

const d1Out = run("1/3 Create D1 database", `npx wrangler d1 create ${args.db}`);
const r2Out = run("2/3 Create R2 bucket", `npx wrangler r2 bucket create ${args.bucket}`);
const kvOut = run("3/3 Create KV namespace", `npx wrangler kv namespace create ${args.kv}`);

// Try to extract IDs for convenience.
const dbId = d1Out.match(/database_id\s*=\s*"([^"]+)"/)?.[1];
const kvId = kvOut.match(/id\s*=\s*"([^"]+)"/)?.[1];

console.log("\n──── Summary ────");
console.log(`D1 database:  ${args.db}${dbId ? `  (id: ${dbId})` : ""}`);
console.log(`R2 bucket:    ${args.bucket}`);
console.log(`KV namespace: ${args.kv}${kvId ? `  (id: ${kvId})` : ""}`);

console.log(`
Next steps:
  1. Open wrangler.toml and paste the IDs above into the matching bindings
     (replace LOCAL_DB_ID and LOCAL_KV_ID).
  2. Set your Better Auth secret:
       wrangler secret put BETTER_AUTH_SECRET
  3. Apply migrations locally and seed:
       pnpm db:migrate
       pnpm db:seed
  4. Start the dev server:
       pnpm wrangler:dev
`);

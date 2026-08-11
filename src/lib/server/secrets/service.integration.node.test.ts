import Database from "better-sqlite3";
import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import {
  getSecret,
  getSecrets,
  listSecretStatus,
  setSecret,
  deleteSecret,
} from "./service";

/**
 * Service tests against REAL SQLite with the REAL migrations applied.
 *
 * Unit-testing the crypto proves the primitives; this proves the behaviour
 * that actually protects credentials — masking, env precedence, and the
 * refusal to store unmanaged keys — against a database that really has the
 * `managed_secrets` table created by `drizzle/0022_managed_secrets.sql`.
 */
const MIGRATIONS_DIR = new URL("../../../../drizzle", import.meta.url).pathname;
const MASTER = "integration-test-master-secret";

/** Minimal D1Database shim over better-sqlite3, enough for Drizzle's d1 driver. */
function d1Shim(db: Database.Database): D1Database {
  const run = (sql: string, params: unknown[]) => {
    // D1 accepts `?1`-style numbered placeholders (used throughout this
    // codebase) but better-sqlite3 rejects them when bound positionally.
    // Rewrite to bare `?` so the SAME SQL string that ships to D1 is what
    // these tests execute — otherwise the test would validate a query the
    // application never runs.
    const stmt = db.prepare(sql.replace(/\?\d+/g, "?"));
    if (/^\s*(select|pragma)/i.test(sql)) {
      const results = stmt.all(...params);
      return { results, success: true, meta: {} };
    }
    const info = stmt.run(...params);
    return { results: [], success: true, meta: { changes: info.changes } };
  };
  const makeStmt = (sql: string, params: unknown[] = []): D1PreparedStatement =>
    ({
      bind: (...p: unknown[]) => makeStmt(sql, p),
      all: async () => run(sql, params),
      run: async () => run(sql, params),
      first: async (col?: string) => {
        const r = run(sql, params).results as Record<string, unknown>[];
        const row = r[0] ?? null;
        return col && row ? row[col] : row;
      },
      raw: async () =>
        (run(sql, params).results as Record<string, unknown>[]).map((r) =>
          Object.values(r),
        ),
    }) as unknown as D1PreparedStatement;

  return {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts: D1PreparedStatement[]) =>
      Promise.all(stmts.map((s) => s.run())),
    exec: async (sql: string) => {
      db.exec(sql);
      return { count: 0, duration: 0 };
    },
    dump: async () => new ArrayBuffer(0),
  } as unknown as D1Database;
}

let sqlite: Database.Database;
let env: Record<string, unknown> & { DB: D1Database };

beforeEach(() => {
  sqlite = new Database(":memory:");
  for (const file of readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(`${MIGRATIONS_DIR}/${file}`, "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) {
      if (stmt.trim()) sqlite.exec(stmt);
    }
  }
  env = { DB: d1Shim(sqlite), BETTER_AUTH_SECRET: MASTER };
});

describe("secret storage", () => {
  it("stores and retrieves a value", async () => {
    await setSecret(env, "BEAM_API_KEY", "sk_live_secret123456", "user1");
    expect(await getSecret(env, "BEAM_API_KEY")).toBe("sk_live_secret123456");
  });

  it("stores ONLY ciphertext in the database", async () => {
    // The core security property. If this fails, a D1 dump leaks keys.
    const plaintext = "sk_live_verysecret9876";
    await setSecret(env, "BEAM_API_KEY", plaintext, "user1");

    const row = sqlite
      .prepare(`SELECT value_encrypted FROM managed_secrets WHERE key = ?`)
      .get("BEAM_API_KEY") as { value_encrypted: string };

    expect(row.value_encrypted).not.toContain(plaintext);
    expect(row.value_encrypted).not.toContain("verysecret");
    expect(row.value_encrypted).toMatch(/^v1:/);
  });

  it("replaces on re-save rather than duplicating", async () => {
    await setSecret(env, "BEAM_API_KEY", "first-value-here", "user1");
    await setSecret(env, "BEAM_API_KEY", "second-value-here", "user2");

    const count = sqlite
      .prepare(`SELECT COUNT(*) c FROM managed_secrets WHERE key = ?`)
      .get("BEAM_API_KEY") as { c: number };
    expect(count.c).toBe(1);
    expect(await getSecret(env, "BEAM_API_KEY")).toBe("second-value-here");
  });

  it("records who changed it", async () => {
    await setSecret(env, "BEAM_API_KEY", "value-goes-here", "admin-42");
    const row = sqlite
      .prepare(`SELECT updated_by FROM managed_secrets WHERE key = ?`)
      .get("BEAM_API_KEY") as { updated_by: string };
    expect(row.updated_by).toBe("admin-42");
  });

  it("refuses to store an unmanaged key", async () => {
    // Guards the write path against a crafted form POST.
    await expect(
      setSecret(env, "BETTER_AUTH_SECRET", "hijack", "attacker"),
    ).rejects.toThrow(/unmanaged/i);
    await expect(
      setSecret(env, "DATABASE_URL", "hijack", "attacker"),
    ).rejects.toThrow(/unmanaged/i);
  });

  it("refuses to delete an unmanaged key", async () => {
    await expect(deleteSecret(env, "BETTER_AUTH_SECRET")).rejects.toThrow(
      /unmanaged/i,
    );
  });

  it("refuses to store without a master secret", async () => {
    const noMaster = { DB: env.DB } as typeof env;
    await expect(
      setSecret(noMaster, "BEAM_API_KEY", "value", "u"),
    ).rejects.toThrow(/BETTER_AUTH_SECRET/);
  });

  it("deletes a stored value", async () => {
    await setSecret(env, "BEAM_API_KEY", "value-to-delete", "u");
    await deleteSecret(env, "BEAM_API_KEY");
    expect(await getSecret(env, "BEAM_API_KEY")).toBeNull();
  });
});

describe("env precedence", () => {
  it("env wins over a stored value", async () => {
    // Load-bearing: lets a leaked key be rotated with `wrangler secret put`
    // without needing a working admin panel.
    await setSecret(env, "BEAM_API_KEY", "database-value", "u");
    const withEnv = { ...env, BEAM_API_KEY: "env-value" };
    expect(await getSecret(withEnv, "BEAM_API_KEY")).toBe("env-value");
  });

  it("ignores an empty-string env var and falls through to the database", async () => {
    // An unset Cloudflare var can surface as "" — treating that as set
    // would silently disable a correctly-configured DB credential.
    //
    // Note this is belt-and-braces: `envValue` filters empty strings AND
    // every caller branches on truthiness, so either alone suffices. The
    // test asserts the observable behaviour, which is what matters.
    await setSecret(env, "BEAM_API_KEY", "database-value", "u");
    const withEmpty = { ...env, BEAM_API_KEY: "" };
    expect(await getSecret(withEmpty, "BEAM_API_KEY")).toBe("database-value");

    // Whitespace is NOT treated as empty — a value of " " is a real (if
    // wrong) configuration, and silently ignoring it would mask a typo
    // rather than surfacing it.
    const withSpace = { ...env, BEAM_API_KEY: " " };
    expect(await getSecret(withSpace, "BEAM_API_KEY")).toBe(" ");
  });

  it("listSecretStatus also treats an empty env var as unset", async () => {
    // Separate path from getSecret — a regression here would show
    // "Set in Cloudflare" for a variable that is effectively absent,
    // and hide the input that would let an admin fix it.
    await setSecret(env, "BEAM_API_KEY", "database-value", "u");
    const withEmpty = { ...env, BEAM_API_KEY: "" };
    const beam = (await listSecretStatus(withEmpty)).find(
      (s) => s.key === "BEAM_API_KEY",
    )!;
    expect(beam.source).toBe("database");
  });

  it("batch resolve mixes env and database sources correctly", async () => {
    await setSecret(env, "BEAM_WEBHOOK_SECRET", "db-webhook-secret", "u");
    const mixed = { ...env, BEAM_API_KEY: "env-api-key" };
    const out = await getSecrets(mixed, [
      "BEAM_API_KEY",
      "BEAM_WEBHOOK_SECRET",
      "RESEND_API_KEY",
    ]);
    expect(out.BEAM_API_KEY).toBe("env-api-key");
    expect(out.BEAM_WEBHOOK_SECRET).toBe("db-webhook-secret");
    expect(out.RESEND_API_KEY).toBeNull();
  });

  it("returns null rather than throwing when the master secret is absent", async () => {
    await setSecret(env, "BEAM_API_KEY", "stored-value", "u");
    const noMaster = { DB: env.DB } as typeof env;
    // Degrades one integration; must not throw on every request.
    expect(await getSecret(noMaster, "BEAM_API_KEY")).toBeNull();
  });
});

describe("status listing (what the admin page receives)", () => {
  it("NEVER returns the plaintext of a sensitive secret", async () => {
    // The single most important assertion here. A regression would put a
    // live payment key into page source, history, and every proxy in path.
    const plaintext = "sk_live_topsecret4321";
    await setSecret(env, "BEAM_API_KEY", plaintext, "u");

    const statuses = await listSecretStatus(env);
    const serialised = JSON.stringify(statuses);

    expect(serialised).not.toContain(plaintext);
    expect(serialised).not.toContain("topsecret");

    const beam = statuses.find((s) => s.key === "BEAM_API_KEY")!;
    expect(beam.preview).toBe("••••••••4321");
    expect(beam.configured).toBe(true);
    expect(beam.source).toBe("database");
  });

  it("masks an env-sourced sensitive value too", async () => {
    const withEnv = { ...env, BEAM_API_KEY: "sk_live_fromenv98765" };
    const statuses = await listSecretStatus(withEnv);
    expect(JSON.stringify(statuses)).not.toContain("sk_live_fromenv98765");
    const beam = statuses.find((s) => s.key === "BEAM_API_KEY")!;
    expect(beam.source).toBe("env");
    expect(beam.preview).toBe("••••••••8765");
  });

  it("shows the non-sensitive merchant id in full", async () => {
    // Masking a public identifier just makes it unverifiable against the
    // Beam dashboard.
    await setSecret(env, "BEAM_MERCHANT_ID", "codustry-ova1t0", "u");
    const statuses = await listSecretStatus(env);
    const merchant = statuses.find((s) => s.key === "BEAM_MERCHANT_ID")!;
    expect(merchant.preview).toBe("codustry-ova1t0");
  });

  it("reports every registry key, including unset ones", async () => {
    const statuses = await listSecretStatus(env);
    // Don't hardcode the registry size — compare against the registry
    // itself (same lesson as the WORKERS_ENV count check, #148).
    const { MANAGED_SECRETS } = await import("./registry");
    expect(statuses.length).toBe(MANAGED_SECRETS.length);
    for (const s of statuses) {
      expect(s.configured).toBe(false);
      expect(s.source).toBe("unset");
      expect(s.preview).toBeNull();
    }
  });

  it("flags a row that cannot be decrypted after key rotation", async () => {
    await setSecret(env, "BEAM_API_KEY", "value-from-before", "u");
    // Simulate BETTER_AUTH_SECRET rotation.
    const rotated = { ...env, BETTER_AUTH_SECRET: "a-completely-new-secret" };

    const statuses = await listSecretStatus(rotated);
    const beam = statuses.find((s) => s.key === "BEAM_API_KEY")!;
    expect(beam.undecryptable).toBe(true);
    expect(beam.configured).toBe(false);
    expect(beam.preview).toBeNull();
  });
});

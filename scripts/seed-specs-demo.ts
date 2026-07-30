/**
 * Spec/attribute demo seed — Phase 3 proof (#88).
 *
 * Loads typed, unit-aware specs from an external JSON file onto the
 * entities the Phase 2 seed created. Same source-agnostic shape as
 * `seed-registry-demo.ts`: a thin script over the schema, so a Strapi
 * export or a CSV is a different reader against the same tables.
 *
 * Deliberately authors the SAME attribute in DIFFERENT units across
 * entities (63 m3/h vs 100 m3/min, 0.1 mbar vs 1 Torr). That's the point:
 * normalization means faceting and sorting stay correct anyway, which is
 * the claim the whole layer rests on.
 *
 * Usage:
 *   pnpm tsx scripts/seed-specs-demo.ts
 *   pnpm tsx scripts/seed-specs-demo.ts --remote
 *   pnpm tsx scripts/seed-specs-demo.ts --file ./my-specs.json
 *
 * Run `pnpm db:seed:registry` first — this attaches specs to its
 * entities.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FAMILIES,
  isMeasureFamily,
  normalize,
} from "../src/lib/server/content/attributes/units";

interface FixtureAttribute {
  key: string;
  dataType:
    | "number"
    | "measurement"
    | "select"
    | "multiselect"
    | "boolean"
    | "text";
  measureFamily?: string;
  options?: string[];
  groupKey?: string;
  position?: number;
  labels?: Record<string, string>;
}

interface FixtureFamily {
  key: string;
  attributes: {
    key: string;
    required?: boolean;
    sortOrder?: number;
    isVariantAxis?: boolean;
  }[];
}

interface FixtureEntity {
  entityType: string;
  /** Must match an id the registry seed created (`seed_ent_<key>`). */
  entityId: string;
  family?: string;
  values: Record<
    string,
    number | boolean | string | string[] | { value: number; unit: string }
  >;
}

interface Fixture {
  attributes: FixtureAttribute[];
  families: FixtureFamily[];
  entities: FixtureEntity[];
}

const args = process.argv.slice(2);
const remote = args.includes("--remote");
const fileArg = args.indexOf("--file");
const fixturePath = resolve(
  fileArg >= 0 && args[fileArg + 1]
    ? args[fileArg + 1]
    : "scripts/fixtures/specs-demo.json",
);
const dbName =
  process.env.D1_DB_NAME ?? (remote ? "khaopad-db-staging" : "khaopad-db");

const fixture: Fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

/**
 * execFileSync with an argument array — never a shell string — so
 * fixture content can't be interpreted as shell syntax.
 */
function exec(sql: string): void {
  execFileSync(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      dbName,
      remote ? "--remote" : "--local",
      "--command",
      sql,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
}

/** SQLite string literal — doubles embedded single quotes. */
function lit(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** Deterministic ids so re-running is idempotent. */
function idFor(kind: string, key: string): string {
  return `spec_${kind}_${key}`.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 60);
}

const NOW = "2026-07-30T00:00:00.000Z";

console.log(`Seeding specs from ${fixturePath} → ${dbName}`);

// ── Attribute definitions
const attrById = new Map<string, FixtureAttribute>();
for (const attr of fixture.attributes) {
  attrById.set(attr.key, attr);
  const id = idFor("attr", attr.key);

  let standardUnit: string | null = null;
  if (attr.dataType === "measurement") {
    if (!attr.measureFamily || !isMeasureFamily(attr.measureFamily)) {
      throw new Error(
        `Attribute "${attr.key}" is a measurement but has an invalid measureFamily: ${attr.measureFamily}`,
      );
    }
    standardUnit = FAMILIES[attr.measureFamily].standardUnit;
  }

  exec(
    `INSERT OR REPLACE INTO attribute_definitions
       (id,key,data_type,measure_family,standard_unit,options_json,group_key,position,created_by,created_at,updated_at)
     VALUES (${lit(id)}, ${lit(attr.key)}, ${lit(attr.dataType)},
             ${lit(attr.measureFamily ?? null)}, ${lit(standardUnit)},
             ${lit(attr.options ? JSON.stringify(attr.options) : null)},
             ${lit(attr.groupKey ?? null)}, ${attr.position ?? 0}, NULL,
             ${lit(NOW)}, ${lit(NOW)})`,
  );

  for (const [locale, label] of Object.entries(attr.labels ?? {})) {
    exec(
      `INSERT OR REPLACE INTO attribute_definition_localizations
         (id,attribute_id,locale,label,description,option_labels_json)
       VALUES (${lit(`${id}_${locale}`)}, ${lit(id)}, ${lit(locale)},
               ${lit(label)}, NULL, NULL)`,
    );
  }
}
console.log(`  ${fixture.attributes.length} attribute definitions`);

// ── Families
for (const family of fixture.families) {
  const fid = idFor("fam", family.key);
  exec(
    `INSERT OR REPLACE INTO attribute_families
       (id,key,labels_json,description,created_by,created_at,updated_at)
     VALUES (${lit(fid)}, ${lit(family.key)}, NULL, NULL, NULL, ${lit(NOW)}, ${lit(NOW)})`,
  );
  for (const fa of family.attributes) {
    const attr = attrById.get(fa.key);
    if (!attr) {
      throw new Error(
        `Family "${family.key}" references unknown attribute "${fa.key}"`,
      );
    }
    // Mirror the service's variant-axis rule so the fixture can't create
    // a state the API would reject.
    if (
      fa.isVariantAxis &&
      !["select", "measurement", "boolean"].includes(attr.dataType)
    ) {
      throw new Error(
        `"${fa.key}" is a ${attr.dataType} and cannot be a variant axis`,
      );
    }
    exec(
      `INSERT OR REPLACE INTO family_attributes
         (family_id,attribute_id,required,sort_order,is_variant_axis,created_at)
       VALUES (${lit(fid)}, ${lit(idFor("attr", fa.key))},
               ${fa.required ? 1 : 0}, ${fa.sortOrder ?? 0},
               ${fa.isVariantAxis ? 1 : 0}, ${lit(NOW)})`,
    );
  }
}
console.log(`  ${fixture.families.length} families`);

// ── Values
let valueCount = 0;
for (const entity of fixture.entities) {
  if (entity.family) {
    exec(
      `INSERT OR REPLACE INTO entity_families
         (entity_type,entity_id,family_id,created_at)
       VALUES (${lit(entity.entityType)}, ${lit(entity.entityId)},
               ${lit(idFor("fam", entity.family))}, ${lit(NOW)})`,
    );
  }

  for (const [key, raw] of Object.entries(entity.values)) {
    const attr = attrById.get(key);
    if (!attr)
      throw new Error(`Unknown attribute "${key}" on ${entity.entityId}`);

    let valueNumber: number | null = null;
    let valueUnit: string | null = null;
    let valueText: string | null = null;
    let valueJson: string | null = null;
    let valueBool: boolean | null = null;

    switch (attr.dataType) {
      case "measurement": {
        if (
          typeof raw !== "object" ||
          raw === null ||
          Array.isArray(raw) ||
          typeof (raw as { value?: unknown }).value !== "number"
        ) {
          throw new Error(
            `"${key}" is a measurement and needs {value, unit}, got ${JSON.stringify(raw)}`,
          );
        }
        const m = raw as { value: number; unit: string };
        // THE POINT OF THIS SEED: store the canonical magnitude so
        // faceting is unit-correct, and keep the authored unit so the
        // datasheet renders what the editor typed.
        const n = normalize(
          attr.measureFamily as Parameters<typeof normalize>[0],
          m.value,
          m.unit,
        );
        valueNumber = n.standardValue;
        valueUnit = n.unit;
        break;
      }
      case "number":
        if (typeof raw !== "number") throw new Error(`"${key}" needs a number`);
        valueNumber = raw;
        break;
      case "boolean":
        if (typeof raw !== "boolean")
          throw new Error(`"${key}" needs a boolean`);
        valueBool = raw;
        break;
      case "multiselect": {
        if (!Array.isArray(raw)) throw new Error(`"${key}" needs an array`);
        for (const o of raw) {
          if (!attr.options?.includes(o)) {
            throw new Error(`"${o}" is not an option of "${key}"`);
          }
        }
        valueJson = JSON.stringify(raw);
        break;
      }
      case "select": {
        if (typeof raw !== "string") throw new Error(`"${key}" needs a string`);
        if (!attr.options?.includes(raw)) {
          throw new Error(`"${raw}" is not an option of "${key}"`);
        }
        valueText = raw;
        break;
      }
      case "text":
        if (typeof raw !== "string") throw new Error(`"${key}" needs a string`);
        valueText = raw;
        break;
    }

    // locale is the '*' sentinel, never NULL — a NULL would make the
    // (entity, attribute, locale) unique index inert in SQLite and let
    // duplicate rows through.
    exec(
      `INSERT OR REPLACE INTO attribute_values
         (id,entity_type,entity_id,attribute_id,locale,value_number,value_unit,value_text,value_json,value_bool,created_at,updated_at)
       VALUES (${lit(`${idFor("val", entity.entityId)}_${key}`)},
               ${lit(entity.entityType)}, ${lit(entity.entityId)},
               ${lit(idFor("attr", key))}, '*',
               ${lit(valueNumber)}, ${lit(valueUnit)}, ${lit(valueText)},
               ${lit(valueJson)}, ${lit(valueBool)},
               ${lit(NOW)}, ${lit(NOW)})`,
    );
    valueCount++;
  }
}

console.log(
  `  ${fixture.entities.length} entities, ${valueCount} values\n` +
    `Done. Try:\n` +
    `  GET /api/public/specs/entry/${fixture.entities[0]?.entityId}?locale=en\n` +
    `  GET /api/public/specs/compare?type=entry&ids=${fixture.entities.map((e) => e.entityId).join(",")}\n` +
    `  GET /api/public/specs/facet/flow_rate?min=100&unit=m3/h`,
);

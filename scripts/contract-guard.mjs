#!/usr/bin/env node
/**
 * Theme-contract guard — #174 Step 7.
 *
 * The engine↔theme contract (docs/THEME-CONTRACT.md) promises deployments
 * that the seams they build against do not silently shrink. This script is
 * the enforcement: it re-extracts the contract surface from the sources and
 * compares it against theme-contract.baseline.json with FLOOR semantics —
 * every baseline item must still exist; additions are fine and reported.
 *
 * Why floor, not exact-match: additions are the contract's own definition of
 * a MINOR change and must not break CI, or people stop adding. Removals are
 * MAJOR by definition, so a removal fails the build until someone bumps the
 * MAJOR of THEME_CONTRACT_VERSION and regenerates the baseline in the same
 * commit — which is exactly the reviewable decision we want to force.
 *
 *   node scripts/contract-guard.mjs            # verify (CI)
 *   node scripts/contract-guard.mjs --update   # regenerate baseline
 *
 * Extraction is text-based, same trade-off as the repo's structural pin
 * tests: a full TS program would be sturdier but needs a compiler at CI
 * time; what actually regresses (a field deleted, a key renamed) is
 * text-visible.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(root, p), "utf8");

const BASELINE_PATH = resolve(root, "theme-contract.baseline.json");

/** Fields of an exported `type X = { ... }` block — top-level names only. */
function typeFields(source, typeName) {
  const start = source.indexOf(`export type ${typeName} =`);
  if (start === -1) throw new Error(`type ${typeName} not found`);
  const open = source.indexOf("{", start);
  let depth = 0;
  let end = open;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}") depth--;
    if (depth === 0) {
      end = i;
      break;
    }
  }
  const body = source.slice(open + 1, end);
  const fields = [];
  let level = 0;
  for (const line of body.split("\n")) {
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const m = level === 0 && line.match(/^\s+(\w+)\??:/);
    if (m) fields.push(m[1]);
    level += opens - closes;
  }
  return fields.sort();
}

function extract() {
  const chrome = read("src/lib/components/www/chrome.ts");
  const checkout = read("src/plugins/shop/checkout-extensions.ts");
  const contract = read("src/lib/theme-contract.ts");

  const version = contract.match(
    /THEME_CONTRACT_VERSION = "(\d+\.\d+\.\d+)"/,
  )?.[1];
  if (!version) throw new Error("THEME_CONTRACT_VERSION not found");

  // Checkout slot names come from the union type's string literals.
  const slotUnion = checkout.slice(
    checkout.indexOf("export type CheckoutSlotName"),
    checkout.indexOf(";", checkout.indexOf("export type CheckoutSlotName")),
  );
  const checkoutSlots = [...slotUnion.matchAll(/"(\w+)"/g)]
    .map((m) => m[1])
    .sort();

  // billingAddress fields: the nested block inside CheckoutContribution.
  const contribStart = checkout.indexOf("export type CheckoutContribution");
  const baOpen = checkout.indexOf("billingAddress?: {", contribStart);
  const baEnd = checkout.indexOf("};", baOpen);
  const billingAddressFields = [
    ...checkout.slice(baOpen + 18, baEnd).matchAll(/^\s+(\w+)\??:/gm),
  ]
    .map((m) => m[1])
    .sort();

  const svelteIn = (dir) =>
    readdirSync(resolve(root, dir))
      .filter((f) => f.endsWith(".svelte"))
      .map((f) => f.replace(/\.svelte$/, ""))
      .sort();

  const messages = JSON.parse(read("messages/en.json"));
  const messageKeys = Object.keys(messages)
    .filter((k) => !k.startsWith("$"))
    .sort();

  return {
    contractVersion: version,
    chromeSlots: typeFields(chrome, "ChromeOverrides"),
    siteHeaderProps: typeFields(chrome, "SiteHeaderProps"),
    siteFooterProps: typeFields(chrome, "SiteFooterProps"),
    homePageProps: typeFields(chrome, "HomePageProps"),
    checkoutSlots,
    checkoutSlotProps: typeFields(checkout, "CheckoutSlotProps"),
    billingAddressFields,
    shopComponents: svelteIn("src/lib/components/shop"),
    wwwComponents: svelteIn("src/lib/components/www"),
    messageKeys,
  };
}

const current = extract();

if (process.argv.includes("--update")) {
  writeFileSync(BASELINE_PATH, JSON.stringify(current, null, 2) + "\n");
  console.log(
    `[contract-guard] baseline updated for contract v${current.contractVersion} ` +
      `(${current.messageKeys.length} message keys).`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const failures = [];
let additions = 0;

for (const [group, items] of Object.entries(baseline)) {
  if (group === "contractVersion") continue;
  const have = new Set(current[group] ?? []);
  for (const item of items) {
    if (!have.has(item)) failures.push(`${group}: "${item}" is gone`);
  }
  additions +=
    (current[group] ?? []).length - items.filter((i) => have.has(i)).length;
}

if (baseline.contractVersion !== current.contractVersion) {
  failures.push(
    `contractVersion: baseline says ${baseline.contractVersion}, ` +
      `source says ${current.contractVersion} — regenerate the baseline ` +
      `(--update) in the same commit as a version change`,
  );
}

if (failures.length > 0) {
  console.error(
    `[contract-guard] CONTRACT BREAK — ${failures.length} item(s):`,
  );
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error(
    "\nEvery item above is surface a deployment may already depend on " +
      "(docs/THEME-CONTRACT.md). Removing or renaming it is a MAJOR change: " +
      "bump THEME_CONTRACT_VERSION in src/lib/theme-contract.ts and run " +
      "`node scripts/contract-guard.mjs --update` in the SAME commit, so the " +
      "break is an explicit, reviewable decision — never a quiet refactor.",
  );
  process.exit(1);
}

console.log(
  `[contract-guard] OK — contract v${current.contractVersion} floor holds` +
    (additions > 0 ? ` (+${additions} addition(s) since baseline).` : "."),
);

/**
 * The engine↔theme contract version — #174 Step 7.
 *
 * This single constant names the promise the engine makes to deployments:
 * everything listed in docs/THEME-CONTRACT.md keeps working, unchanged,
 * for as long as the MAJOR component of this version holds.
 *
 * Semver rules, applied to the contract surface (not the package version):
 * - MAJOR — anything in the contract removed, renamed, or reshaped:
 *   a chrome slot, a slot-props field, a checkout contribution field,
 *   a `$lib/components/shop` or `$lib/components/www` building block,
 *   a Paraglide message key. Every registered theme must be re-checked.
 * - MINOR — surface added: a new slot, a new optional props field, new
 *   message keys, a new building block. Existing themes are unaffected.
 * - PATCH — doc-only clarifications; no surface change.
 *
 * `scripts/contract-guard.mjs` enforces the floor in CI: the baseline
 * (theme-contract.baseline.json) is the minimum surface, and a build in
 * which any baseline item has vanished fails until the version's MAJOR is
 * bumped and the baseline regenerated in the same commit — so a contract
 * break can never ship as a quiet refactor.
 */
export const THEME_CONTRACT_VERSION = "1.0.0";

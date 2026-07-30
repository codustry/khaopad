/**
 * Attribute layer public surface — Phase 3 (#88).
 */
import { AttributeService } from "./service";

export { AttributeService, AttributeError } from "./service";
export type {
  ResolvedValue,
  DatasheetGroup,
  CreateAttributeInput,
  RawValueInput,
} from "./service";
export {
  FAMILIES,
  MEASURE_FAMILIES,
  isMeasureFamily,
  normalize,
  denormalize,
  resolveUnit,
  unitsFor,
  UnitError,
  type MeasureFamily,
} from "./units";
export * from "./schema";

export function createAttributeService(
  env: App.Platform["env"],
): AttributeService {
  const supportedLocales = (env.SUPPORTED_LOCALES ?? "en,th")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  return new AttributeService(env.DB, {
    supportedLocales,
    defaultLocale: env.DEFAULT_LOCALE ?? supportedLocales[0] ?? "en",
  });
}

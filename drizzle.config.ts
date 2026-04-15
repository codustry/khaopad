import type { Config } from "drizzle-kit";

export default {
  schema: "./src/lib/server/content/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
} satisfies Config;

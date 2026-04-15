import type { ContentProvider } from "./types";
import { D1ContentProvider } from "./providers/d1";
// import { GitHubContentProvider } from './providers/github'; // v1.1

export type ContentMode = "d1" | "github";

export function createContentProvider(
  mode: ContentMode,
  env: App.Platform["env"],
): ContentProvider {
  switch (mode) {
    case "d1":
      return new D1ContentProvider(env.DB);

    case "github":
      // TODO: Implement in v1.1
      throw new Error(
        "GitHub content mode is not yet implemented. Use CONTENT_MODE=d1 for now.",
      );

    default:
      throw new Error(`Unknown content mode: ${mode}`);
  }
}

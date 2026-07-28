/**
 * Public plugin API.
 *
 * Plugin authors import from here:
 *
 *   import { defineKhaopadPlugin, type KhaopadPlugin } from "$lib/plugins";
 *
 * Core code that needs to trigger init or enumerate plugins:
 *
 *   import { initPlugins, listEnabledPlugins } from "$lib/plugins";
 */
export {
  defineKhaopadPlugin,
  type KhaopadPlugin,
  type PluginInitContext,
} from "./types";
export { initPlugins, listEnabledPlugins } from "./runtime";

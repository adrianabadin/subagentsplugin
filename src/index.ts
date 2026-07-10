/**
 * PR4 — OpenCode plugin package-root entry point.
 *
 * Loader contract: OpenCode's plugin loader imports the package root and
 * iterates EVERY runtime export, requiring each to be a Plugin function.
 * A public-API barrel (constants like `CONTEXT_SIZE_THRESHOLDS`, helper
 * functions like `forecast`) on the root causes the loader to reject the
 * package with `Plugin export is not a function`. Therefore this module
 * re-exports ONLY the default plugin function.
 *
 * - Plugin implementation lives in `src/plugin.ts`.
 * - Public / programmatic API (plugin factory, `refreshCache`, forecast /
 *   scoring / rubric / evidence helpers and types) lives in `src/api.ts`
 *   (package export `./api`).
 */

export { default } from "./plugin.js";

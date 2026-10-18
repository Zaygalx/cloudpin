import { createRequire } from "node:module";

/*
 * cloudpin's version, in one place. The npm package reads it from its own
 * package.json. The standalone cloudpin.exe (#96) can't: inside a Node single
 * executable application `import.meta.url` is the exe's path and `require`
 * loads only built-in modules (nodejs.org/api/single-executable-applications.html,
 * "In the injected main script"), so scripts/build-exe.mjs replaces
 * CLOUDPIN_BUNDLED_VERSION with the version as a string literal when it
 * bundles. Unbundled, the name is never declared and `typeof` gives "undefined".
 */
declare const CLOUDPIN_BUNDLED_VERSION: string | undefined;

export const VERSION: string =
  typeof CLOUDPIN_BUNDLED_VERSION === "string"
    ? CLOUDPIN_BUNDLED_VERSION
    : (createRequire(import.meta.url)("../package.json") as { version: string }).version;

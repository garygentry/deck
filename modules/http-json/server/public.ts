/**
 * The http-json module's public server entry: what other modules may use of its server half.
 * The remote module polls through the same fetch and shares its instance request settings.
 * Import from this file only, and declare the dependency in package.json;
 * `apps/server/test/module-imports.test.ts` enforces both.
 */

export { fetchJson, HttpJsonError, type HttpJsonConfig } from "./index.js";
export { urlProblem } from "./literal.js";
export { instanceRequest, integer, sharedInstanceProperties, type InstanceRequest } from "./request-config.js";

/**
 * node10-resolution type stub (tsconfig.base.json uses moduleResolution
 * "node", which cannot follow package.json `exports` subpaths). TypeScript
 * builds that consume `@form/auth/server` under that setting resolve this
 * folder instead; runtime loading always uses the real `exports` map
 * (`./dist/server/index.js`) because Node honors `exports` first.
 */
export * from "../dist/server/index";

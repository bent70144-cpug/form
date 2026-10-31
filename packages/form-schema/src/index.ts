/**
 * @form/form-schema — the shared form-schema package (ticket 07).
 *
 * Pure, dependency-light (zod is the only runtime dependency), no Node/DOM-only
 * APIs, no imports from other packages. The envelope and block union are
 * specified in spec.md "Form schema and versioning".
 */

export * from "./constants";
export * from "./helpers";
export * from "./migrate";
export * from "./schema";
export * from "./types";
export * from "./validate";
export * from "./answers";

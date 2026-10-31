"use strict";
/**
 * Form schema envelope and the M0 block union (spec: "Form schema and
 * versioning"). Skeleton slice of ticket 01: stable envelope type, defaults and
 * `emptyDraft()`. Zod validation of the envelope arrives with the draft API
 * slice (ticket 07).
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_SETTINGS = exports.DEFAULT_THEME = void 0;
exports.emptyDraft = emptyDraft;
exports.DEFAULT_THEME = { preset: "default" };
exports.DEFAULT_SETTINGS = {};
/**
 * The empty draft is exactly:
 * `{ schemaVersion: 1, title: "", blocks: [], logic: [], theme: { preset: "default" }, settings: {} }`
 */
function emptyDraft() {
    return {
        schemaVersion: 1,
        title: "",
        blocks: [],
        logic: [],
        theme: { ...exports.DEFAULT_THEME },
        settings: {},
    };
}
//# sourceMappingURL=index.js.map
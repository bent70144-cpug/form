import { t as translateUntyped } from "@form/i18n";

/**
 * Thin string access to the shared catalog. The e2e suite asserts the SAME
 * i18n values the UI renders, so a copy change cannot silently break the
 * suite and no user-facing copy is hardcoded here. (The e2e package has no
 * business re-exporting the whole catalog type surface — one narrow cast.)
 */
type Translate = (key: string, params?: Record<string, string | number>) => string;
export const t = translateUntyped as unknown as Translate;

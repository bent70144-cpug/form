/**
 * Client-side display of shared-schema issues (ticket 08).
 *
 * The builder runs the SHARED engine (`validateDraftSchema` from
 * @form/form-schema) before scheduling a save — early feedback only; the
 * server re-validates authoritatively (409/422 handled). Issue codes are the
 * stable contract, so their human-readable lines resolve through the shared
 * catalog keys (`errors.schemaIssues.<code>`) — never hardcoded copy.
 */
import { en, t } from "@form/i18n";
import type { Issue } from "@form/form-schema";

const ISSUE_MESSAGES = en.errors.schemaIssues as Readonly<Record<string, string>>;

export function describeIssues(issues: readonly Issue[]): string[] {
  return issues.map((issue) => {
    const message = ISSUE_MESSAGES[issue.code] ?? t("errors.validation.title");
    return issue.path === "" ? message : `${issue.path}: ${message}`;
  });
}

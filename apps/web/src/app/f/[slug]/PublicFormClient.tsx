/**
 * JSX compile note: the web tsconfig uses `jsx: "preserve"`, so Next/SWC
 * compiles this file with the automatic runtime (no React import needed for
 * JSX itself), while the vitest/esbuild pipeline falls back to the classic
 * transform — the explicit `import * as React` below satisfies BOTH, and no
 * @jsx pragma is set (Turbopack rejects pragmas under the automatic runtime).
 */
"use client";
import * as React from "react";
import type { FormBlock, FormDraftSchema } from "@form/contracts";
import { t } from "@form/i18n";
import {
  createPublicSession,
  sessionTokenStorageKey,
  submitPublicAnswers,
} from "./public-session-client";
import {
  blankRequiredBlocks,
  endingBlock,
  mapFieldErrors,
  phaseForSubmitProblem,
  welcomeBlock,
  type PublicFormPhase,
} from "./public-form-machine";

/**
 * The INTERACTIVE public form (ticket 10) — makes T09's read-only /f/[slug]
 * page collect answers and submit them.
 *
 * Lifecycle (spec "Public form and submission lifecycle"):
 * - a pinned session is created ON THE MOUNT (single-page flow) via the
 *   cookie-less, origin-exempt `POST /v1/public/forms/{slug}/sessions`; the
 *   raw token lives in sessionStorage and is sent as `X-Form-Session`;
 * - questions render from the PINNED schema with programmatically associated
 *   labels (htmlFor/id) and error messages (aria-describedby);
 * - required-check is a client-side CONVENIENCE — the server re-validates
 *   against the pinned schema and its stable codes drive the field errors;
 * - a receipt swaps the form for the ending block; closed/expired failures
 *   show the closed / restart messages instead.
 *
 * 360px safety: the container and every input are fluid (`width: 100%`,
 * `box-sizing: border-box`), stacked in a single column — no fixed widths
 * anywhere, so there is no horizontal scrolling at narrow viewports.
 */

const containerStyle = {
  padding: "16px",
  maxWidth: 640,
  margin: "0 auto",
  width: "100%",
  boxSizing: "border-box" as const,
};

const fieldStyle = {
  width: "100%",
  boxSizing: "border-box" as const,
  padding: "8px",
  fontSize: 16,
};

const errorStyle = {
  color: "#b00020",
  margin: "4px 0 0",
  width: "100%",
  boxSizing: "border-box" as const,
};

const stackStyle = {
  display: "flex",
  flexDirection: "column" as const,
  gap: 16,
  width: "100%",
};

export default function PublicFormClient(props: { slug: string; schema: FormDraftSchema }) {
  const blocks = props.schema.blocks;
  const [phase, setPhase] = React.useState<PublicFormPhase>("form");
  const [sessionState, setSessionState] = React.useState<"starting" | "active" | "failed">("starting");
  const [answers, setAnswers] = React.useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const [showFixErrors, setShowFixErrors] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);

  // Session creation on mount. The raw token is returned ONCE — keep it in
  // sessionStorage keyed by slug (survives an accidental reload within the
  // tab; the server treats a second submit of a completed session as the
  // idempotent-receipt path).
  React.useEffect(() => {
    let cancelled = false;
    const stored = typeof window !== "undefined"
      ? window.sessionStorage.getItem(sessionTokenStorageKey(props.slug))
      : null;
    if (stored !== null) {
      setSessionState("active");
      return;
    }
    void createPublicSession(props.slug).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        try {
          window.sessionStorage.setItem(
            sessionTokenStorageKey(props.slug),
            result.session.token,
          );
        } catch {
          // sessionStorage unavailable (private mode) — the in-memory flow
          // still works for this mount; the submit uses the token directly.
        }
        setSessionState("active");
      } else {
        setSessionState("failed");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [props.slug]);

  // Keep the token reachable for submits even when storage is unavailable.
  const tokenRef = React.useRef<string | null>(null);

  const readToken = (): string | null => {
    if (tokenRef.current !== null) return tokenRef.current;
    if (typeof window === "undefined") return null;
    return window.sessionStorage.getItem(sessionTokenStorageKey(props.slug));
  };

  const setAnswer = (blockId: string, value: string): void => {
    setAnswers((prev) => ({ ...prev, [blockId]: value }));
    setFieldErrors((prev) => {
      if (prev[blockId] === undefined) return prev;
      const next = { ...prev };
      delete next[blockId];
      return next;
    });
    setShowFixErrors(false);
  };

  const onSubmit = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (submitting || phase !== "form") return;

    const blank = blankRequiredBlocks(blocks, answers);
    if (blank.length > 0) {
      const errors: Record<string, string> = {};
      for (const id of blank) errors[id] = "required_answer_missing";
      setFieldErrors(errors);
      setShowFixErrors(true);
      return;
    }

    const token = readToken();
    if (token === null) {
      setSessionState("failed");
      return;
    }
    setSubmitting(true);
    setShowFixErrors(false);
    try {
      const result = await submitPublicAnswers(token, answers);
      if (result.ok) {
        // One receipt per session — drop the token so a reload restarts
        // cleanly instead of resubmitting.
        try {
          window.sessionStorage.removeItem(sessionTokenStorageKey(props.slug));
        } catch {
          // ignore storage failures
        }
        tokenRef.current = null;
        setPhase("ended");
        return;
      }
      const nextPhase = phaseForSubmitProblem(result.problem, result.status);
      setPhase(nextPhase);
      if (nextPhase === "form" && result.problem) {
        setFieldErrors(mapFieldErrors(result.problem));
        setShowFixErrors(true);
      }
    } finally {
      setSubmitting(false);
    }
  };

  const welcome = welcomeBlock(blocks);
  const ending = endingBlock(blocks);
  const title = props.schema.title.trim() || t("public.form.formTitleFallback");

  const questionBlocks = blocks.filter(
    (b): b is Extract<FormBlock, { kind: "short_text" | "long_text" }> =>
      b.kind === "short_text" || b.kind === "long_text",
  );

  return (
    <main style={containerStyle}>
      <h1>{title}</h1>
      {phase === "ended" ? (
        <section data-testid="public-form-ended">
          <h2>{ending !== null && ending.title.trim() !== "" ? ending.title : t("public.form.endingTitleFallback")}</h2>
          {ending?.description !== undefined ? <p>{ending.description}</p> : null}
          <p>{t("public.form.submittedDetail")}</p>
        </section>
      ) : phase === "closed" ? (
        <section data-testid="public-form-closed">
          <p>{t("public.form.formClosedInline")}</p>
        </section>
      ) : phase === "expired" ? (
        <section data-testid="public-form-expired">
          <p>{t("public.form.sessionExpiredInline")}</p>
        </section>
      ) : phase === "error" ? (
        <section data-testid="public-form-error">
          <p>{t("public.form.submitFailed")}</p>
        </section>
      ) : sessionState === "failed" ? (
        <section data-testid="public-form-session-failed">
          <p>{t("public.form.sessionStartFailed")}</p>
        </section>
      ) : (
        <form onSubmit={(event) => void onSubmit(event)} style={stackStyle} noValidate>
          {welcome !== null ? (
            <section>
              <h2>{welcome.title}</h2>
              {welcome.description !== undefined ? <p>{welcome.description}</p> : null}
            </section>
          ) : null}

          {showFixErrors ? <p style={errorStyle}>{t("public.form.fixErrorsDetail")}</p> : null}

          {sessionState === "starting" ? (
            <p>{t("public.form.sessionStarting")}</p>
          ) : null}

          {questionBlocks.map((block) => {
            const mark = block.required
              ? t("public.form.requiredMark")
              : t("public.form.optionalMark");
            const label = `${block.label} (${mark})`;
            const fieldId = `f-${block.id}`;
            const errorId = `f-${block.id}-error`;
            const error = fieldErrors[block.id];
            return (
              <section key={block.id}>
                <label htmlFor={fieldId} style={{ display: "block" }}>
                  {label}
                </label>
                {block.description !== undefined ? <p>{block.description}</p> : null}
                {block.kind === "long_text" ? (
                  <textarea
                    id={fieldId}
                    name={block.id}
                    rows={4}
                    value={answers[block.id] ?? ""}
                    placeholder={block.placeholder}
                    aria-invalid={error !== undefined ? true : undefined}
                    aria-describedby={error !== undefined ? errorId : undefined}
                    onChange={(e) => setAnswer(block.id, e.target.value)}
                    style={fieldStyle}
                  />
                ) : (
                  <input
                    id={fieldId}
                    name={block.id}
                    type="text"
                    value={answers[block.id] ?? ""}
                    placeholder={block.placeholder}
                    aria-invalid={error !== undefined ? true : undefined}
                    aria-describedby={error !== undefined ? errorId : undefined}
                    onChange={(e) => setAnswer(block.id, e.target.value)}
                    style={fieldStyle}
                  />
                )}
                {error !== undefined ? (
                  <p id={errorId} role="alert" style={errorStyle}>
                    {t(`errors.schemaIssues.${error}` as never)}
                  </p>
                ) : null}
              </section>
            );
          })}

          <button type="submit" disabled={submitting || sessionState !== "active"} style={fieldStyle}>
            {submitting ? t("public.form.submittingButton") : t("public.form.submitButton")}
          </button>
        </form>
      )}
    </main>
  );
}

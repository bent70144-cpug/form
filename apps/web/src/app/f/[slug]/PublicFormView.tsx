/**
 * Explicit React namespace import: the web tsconfig uses `jsx: "preserve"`
 * (Next/SWC compiles it with the automatic runtime) while the vitest/esbuild
 * pipeline falls back to the classic transform; importing React keeps BOTH
 * compilers pointing at the same element factory without source pragmas
 * (Turbopack rejects `@jsx` when the automatic runtime is active).
 */
import * as React from "react";
import type { FormBlock } from "@form/contracts";
import { t } from "@form/i18n";

/**
 * Read-only public form view (ticket 09) — a presentational component with NO
 * next/navigation imports and NO data fetching, so tests can render it with
 * `react-dom/server` directly.
 *
 * Guarantees the spec pins on the public page:
 * - ALL creator text (titles, labels, descriptions, placeholders) renders as
 *   interpolated children — React's default escaping — never via
 *   dangerouslySetInnerHTML. A label containing `<script>` renders as text.
 * - NO session is created here (ticket 10 adds interactivity): questions
 *   render as DISABLED inputs, purely to show the form's shape.
 * - 360px-safe: the container is fluid (`width: 100%`, `max-width`), every
 *   input is `width: 100%` + `box-sizing: border-box` — no horizontal
 *   scrolling at narrow widths.
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

export default function PublicFormView(props: {
  title: string;
  blocks: FormBlock[];
}) {
  return (
    <main style={containerStyle}>
      <h1>{props.title.trim() || t("public.form.formTitleFallback")}</h1>
      {props.blocks.map((block) => {
        switch (block.kind) {
          case "welcome":
            return (
              <section key={block.id}>
                <h2>{block.title}</h2>
                {block.description !== undefined ? (
                  <p>{block.description}</p>
                ) : null}
              </section>
            );
          case "ending":
            return (
              <section key={block.id}>
                <h2>{block.title}</h2>
                {block.description !== undefined ? (
                  <p>{block.description}</p>
                ) : null}
              </section>
            );
          case "short_text":
          case "long_text": {
            const mark = block.required
              ? t("public.form.requiredMark")
              : t("public.form.optionalMark");
            const label = `${block.label} (${mark})`;
            const fieldId = `f-${block.id}`;
            return (
              <section key={block.id} style={{ marginBottom: 16 }}>
                <label htmlFor={fieldId} style={{ display: "block" }}>
                  {label}
                </label>
                {block.description !== undefined ? (
                  <p>{block.description}</p>
                ) : null}
                {block.kind === "long_text" ? (
                  <textarea
                    id={fieldId}
                    rows={4}
                    disabled
                    placeholder={block.placeholder}
                    style={fieldStyle}
                  />
                ) : (
                  <input
                    id={fieldId}
                    type="text"
                    disabled
                    placeholder={block.placeholder}
                    style={fieldStyle}
                  />
                )}
              </section>
            );
          }
        }
      })}
    </main>
  );
}

/** The closed message (unpublished or soft-deleted form) — same no-store page. */
export function PublicFormClosed() {
  return (
    <main style={containerStyle}>
      <h1>{t("public.form.closedTitle")}</h1>
      <p>{t("public.form.closedDetail")}</p>
    </main>
  );
}

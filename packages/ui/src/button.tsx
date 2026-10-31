"use client";

import type { ButtonHTMLAttributes } from "react";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary";
}

/** Minimal shared React component (spec: "A UI package owns shared React components"). */
export function Button({ variant = "primary", ...rest }: ButtonProps) {
  return (
    <button
      type="button"
      data-variant={variant}
      style={{
        padding: "0.5rem 1rem",
        borderRadius: "0.5rem",
        border: "1px solid #1f2937",
        background: variant === "primary" ? "#1f2937" : "transparent",
        color: variant === "primary" ? "#fff" : "#1f2937",
        cursor: "pointer",
        fontSize: "0.95rem",
      }}
      {...rest}
    />
  );
}

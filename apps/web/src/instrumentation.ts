/**
 * Next.js instrumentation hook (apps/web — the PUBLIC deployable).
 *
 * Next runs `register()` exactly once per server instance, before it serves
 * any request. This is where the web environment guard finally executes in
 * production: `loadWebEnv()` refuses to start when a secret (DATABASE_URL,
 * BETTER_AUTH_SECRET, …) leaked into the web process or a public variable is
 * malformed — spec: "environment configuration is Zod-validated and fails at
 * startup". Until now the guard only ran in tests; a misconfigured deploy
 * would have limped along silently.
 *
 * Per the Next.js docs the instrumentation file is evaluated on every runtime
 * (edge + nodejs), so the guard is gated to the nodejs runtime (the web
 * server that actually carries process.env) and the env module is imported
 * dynamically to keep the edge bundle clean.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { loadWebEnv } = await import("./lib/env");
  // A thrown WebEnvError rejects register() and fails server startup.
  loadWebEnv();
}

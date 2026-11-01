#!/usr/bin/env node
/**
 * Cold-start measurement for the deployed alpha (ticket 12, spec:
 * "Cold-start behavior is measured, including the authenticated SSR session
 * hop").
 *
 * Measures end-to-end latency of the four render paths that matter on the
 * Render free tier (service spins down when idle; the first request after an
 * idle period includes process spin-up):
 *
 *   1. /v1/health      — API liveness + live DB probe (the platform hop)
 *   2. /               — Next.js home SSR (no session)
 *   3. /f/<slug>       — PUBLIC form SSR: Next server component → internal
 *                        API security-definer read (unauthenticated hop)
 *   4. /dashboard      — AUTHENTICATED SSR session hop: middleware cookie
 *                        check → SSR session read → internal API with the
 *                        forwarded cookie. Needs the session cookie.
 *
 * Usage (requires only network access to the deployed origin):
 *
 *   node scripts/measure-cold-start.mjs https://form-alpha.onrender.com \
 *     --slug my-published-slug \
 *     --cookie "better-auth.session_token=…" \
 *     --runs 3 [--json results.json]
 *
 * The cookie can also be passed via the FORM_SESSION_COOKIE env var (copy it
 * from the browser devtools Application tab after signing in on the alpha).
 * Never commit or paste the cookie value into the ticket — it IS a session
 * credential; only timings go into the ticket/report.
 *
 * Interpretation (record numbers, don't guess — see docs/RUNBOOK-deploy.md §4):
 * - The FIRST request after an idle gap includes free-tier spin-up; run the
 *   script twice back-to-back and treat run 1 of run 1 as "cold", the rest as
 *   "warm".
 * - /f/<slug> and /dashboard are always ≥ /v1/health + one internal API hop;
 *   the dashboard hop additionally carries the SSR session read.
 * - Free-tier spin-up is expected and acceptable (spec); do not encode it
 *   into domain code.
 */

const DEFAULT_RUNS = 3;

function parseArgs(argv) {
  const args = { runs: DEFAULT_RUNS, cookie: undefined, slug: undefined, json: undefined, positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--runs": args.runs = Number(next()); break;
      case "--cookie": args.cookie = next(); break;
      case "--slug": args.slug = next(); break;
      case "--json": args.json = next(); break;
      case "--help": args.help = true; break;
      default: {
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        args.positional.push(arg);
      }
    }
  }
  return args;
}

function usage() {
  process.stdout.write(
    [
      "Usage: node scripts/measure-cold-start.mjs <base-url> [options]",
      "",
      "Options:",
      "  --slug <slug>     Published form slug; enables the public /f/<slug> SSR hop",
      "  --cookie <cookie> Session cookie string; enables the authenticated /dashboard SSR hop",
      "                    (or set FORM_SESSION_COOKIE; value stays local, never printed)",
      "  --runs <n>        Requests per target (default 3; first may include spin-up)",
      "  --json <file>     Also write raw timings to a JSON file",
      "",
    ].join("\n"),
  );
}

/** One timed request; returns {status, ms} or {status:"ERR", ms, error}. */
async function timedFetch(url, init) {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual", // middleware redirects count AS the measured outcome
    });
    await response.arrayBuffer(); // drain the body so the timing includes it
    return { status: response.status, ms: Math.round(performance.now() - start) };
  } catch (error) {
    return {
      status: "ERR",
      ms: Math.round(performance.now() - start),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function labelFor(target) {
  switch (target.kind) {
    case "health": return "GET /v1/health (liveness + db probe)";
    case "home": return "GET / (Next SSR, no session)";
    case "public": return `GET /f/${target.slug} (public form SSR → internal API hop)`;
    case "dashboard": return "GET /dashboard (AUTHENTICATED SSR session hop)";
    default: return target.kind;
  }
}

function initFor(target, cookie) {
  if (target.kind !== "dashboard" || !cookie) return {};
  return { headers: { cookie } };
}

function msBar(ms, max) {
  if (max <= 0) return "";
  const width = 30;
  const filled = Math.max(1, Math.round((ms / max) * width));
  return "█".repeat(Math.min(width, filled));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.positional.length !== 1) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const base = args.positional[0].replace(/\/$/, "");
  let parsed;
  try {
    parsed = new URL(base);
  } catch {
    process.stderr.write(`not a valid base URL: ${base}\n`);
    process.exit(1);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    process.stderr.write("base URL must be http(s)\n");
    process.exit(1);
  }

  const cookie = args.cookie ?? process.env.FORM_SESSION_COOKIE;
  const targets = [
    { kind: "health", path: "/v1/health" },
    { kind: "home", path: "/" },
    ...(args.slug ? [{ kind: "public", path: `/f/${encodeURIComponent(args.slug)}`, slug: args.slug }] : []),
    ...(cookie ? [{ kind: "dashboard", path: "/dashboard" }] : []),
  ];

  if (!args.slug) {
    process.stdout.write("note: --slug not given — skipping the public /f/<slug> hop\n");
  }
  if (!cookie) {
    process.stdout.write(
      "note: no session cookie — skipping the AUTHENTICATED /dashboard SSR hop (required by the ticket)\n",
    );
  }

  process.stdout.write(`\nCold-start measurement against ${base} — ${args.runs} run(s) per target\n`);
  process.stdout.write("run 1 may include Render free-tier spin-up if the service was idle\n\n");

  /** @type {Array<{target: string, path: string, run: number, status: string|number, ms: number, error?: string}>} */
  const results = [];

  for (const target of targets) {
    const label = labelFor(target);
    process.stdout.write(`${label}\n`);
    for (let run = 1; run <= args.runs; run++) {
      const outcome = await timedFetch(`${base}${target.path}`, initFor(target, cookie));
      results.push({
        target: label,
        path: target.path,
        run,
        status: outcome.status,
        ms: outcome.ms,
        ...(outcome.error ? { error: outcome.error } : {}),
      });
      process.stdout.write(
        `  run ${run}: ${String(outcome.status).padEnd(4)} ${String(outcome.ms).padStart(6)} ms\n`,
      );
    }
    process.stdout.write("\n");
  }

  // Summary per target: the first run and the best/median of the rest (warm).
  process.stdout.write("Summary (first run ≈ cold if the service was idle; rest ≈ warm)\n\n");
  const byTarget = new Map();
  for (const row of results) {
    if (!byTarget.has(row.target)) byTarget.set(row.target, []);
    byTarget.get(row.target).push(row);
  }
  const summary = [];
  for (const [target, rows] of byTarget) {
    const times = rows.map((r) => r.ms);
    const first = times[0];
    const warm = times.slice(1).sort((a, b) => a - b);
    const median = warm.length === 0 ? first : warm[Math.floor(warm.length / 2)];
    const max = Math.max(first, median);
    summary.push({ target, coldMs: first, warmMedianMs: median });
    process.stdout.write(
      `${target}\n  cold ${String(first).padStart(6)} ms ${msBar(first, max)}\n  warm ${String(median).padStart(6)} ms ${msBar(median, max)}\n\n`,
    );
  }

  process.stdout.write(
    [
      "Record in the ticket (docs/RUNBOOK-deploy.md §4):",
      "  - the cold and warm numbers above,",
      "  - whether run 1 included spin-up (service was idle → Render metrics show a new instance),",
      "  - the dashboard hop delta over /v1/health (the authenticated SSR session hop cost).",
      "",
    ].join("\n"),
  );

  if (args.json) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(args.json, `${JSON.stringify({ base, measuredAt: new Date().toISOString(), summary, results }, null, 2)}\n`);
    process.stdout.write(`raw timings written to ${args.json}\n`);
  }
}

main().catch((error) => {
  process.stderr.write(`measure-cold-start failed: ${error?.stack ?? error}\n`);
  process.exit(1);
});

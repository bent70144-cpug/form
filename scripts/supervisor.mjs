#!/usr/bin/env node
/**
 * Local dev supervisor (spec: "Deployment and configuration").
 *
 * Starts web (Next.js), API (NestJS), the worker and the dev SMTP sink with an
 * EXPLICIT allowlisted environment per child process:
 *
 *   - web   → only public variables + the internal API URL. NEVER DATABASE_URL,
 *             auth secrets, or the migrator URL (enforced by a hard check that
 *             refuses to spawn the child if a forbidden key would be present).
 *   - api   → pooled app_user DATABASE_URL + APP_ORIGIN + BETTER_AUTH_SECRET.
 *             No migrator URL.
 *   - worker→ worker_user URL (direct connection, pg-boss heartbeat).
 *
 * Ticket 02 (alpha topology spike): the web child also receives API_INTERNAL_URL
 * so next.config can build the /v1/* rewrite toward the NestJS internal port.
 *
 * In `--dev` mode it also boots the embedded-postgres substitute (if nothing is
 * listening on 5433), runs the one-time admin bootstrap and the migrations
 * (both idempotent), then starts the children. The pure allowlist logic is
 * exported so CI can test it directly.
 */
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Keys every child needs to run as a process on this machine. */
export const SYSTEM_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TZ",
  "TERM",
  "SHELL",
  "USER",
  "LOGNAME",
  "CI",
  "NODE_ENV",
];

/**
 * Per-role allowlists. If a variable is not listed here (and is not a system
 * key), the child does not see it.
 */
export const ROLE_ALLOWLISTS = {
  web: [
    "PORT",
    "APP_ORIGIN",
    "API_INTERNAL_URL",
    "API_INTERNAL_PORT",
    "LOG_LEVEL",
    "NEXT_TELEMETRY_DISABLED",
  ],
  api: [
    "PORT",
    "DATABASE_URL",
    "APP_ORIGIN",
    "BETTER_AUTH_SECRET",
    "LOG_LEVEL",
  ],
  worker: ["WORKER_DATABASE_URL", "LOG_LEVEL", "HEARTBEAT_INTERVAL_MS"],
  sink: ["SMTP_PORT", "SINK_HTTP_PORT"],
};

/** Nothing matching this may ever reach the browser deployable. */
export const FORBIDDEN_WEB_ENV_PATTERN =
  /DATABASE_URL|PASSWORD|SECRET|TOKEN|MIGRATOR|ADMIN/i;

/**
 * Build the environment for a child process. For `web` this is a hard
 * guarantee: if a forbidden key would reach the Next.js process, the
 * supervisor throws instead of spawning it.
 */
export function buildChildEnv(role, env = process.env) {
  const allow = ROLE_ALLOWLISTS[role];
  if (!allow) {
    throw new Error(`Unknown child role: ${role}`);
  }
  const out = {};
  for (const key of SYSTEM_KEYS) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  for (const key of allow) {
    if (env[key] !== undefined) out[key] = env[key];
  }
  if (role === "web") {
    // Public build-time configuration is safe to forward.
    for (const [key, value] of Object.entries(env)) {
      if (key.startsWith("NEXT_PUBLIC_") && out[key] === undefined) {
        out[key] = value;
      }
    }
    const forbidden = Object.keys(out).filter((key) =>
      FORBIDDEN_WEB_ENV_PATTERN.test(key),
    );
    if (forbidden.length > 0) {
      throw new Error(
        `Refusing to start the web process: forbidden environment keys present: ${forbidden.join(", ")}`,
      );
    }
  }
  return out;
}

function isPortOpen(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function waitForPort(port, host, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port, host)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function runScript(label, args, env) {
  const result = spawnSync("pnpm", ["exec", ...args], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(`[${label}] failed (exit ${result.status})\n`);
    if (result.stdout) process.stderr.write(result.stdout + "\n");
    if (result.stderr) process.stderr.write(result.stderr + "\n");
    process.exit(result.status ?? 1);
  }
  return result;
}

export function devDefaults(env = process.env) {
  const pgPort = env.PG_PORT ?? "5433";
  const pgUser = env.PG_USER ?? "postgres";
  const pgPassword = env.PG_PASSWORD ?? "postgres";
  const devDb = env.DEV_DB_NAME ?? "form_dev";
  const migratorPassword = env.DEV_MIGRATOR_PASSWORD ?? "dev-migrator-pw";
  const appUserPassword = env.DEV_APP_USER_PASSWORD ?? "dev-app-user-pw";
  const workerPassword = env.DEV_WORKER_PASSWORD ?? "dev-worker-pw";
  // Dev-only Better Auth secret. Production value comes from the Render
  // environment (API child only — never the web child).
  const betterAuthSecret = env.BETTER_AUTH_SECRET ?? "dev-only-better-auth-secret";
  const webPort = env.WEB_PORT ?? "3000";
  const apiPort = env.API_PORT ?? "4000";
  return {
    pgPort,
    pgUser,
    pgPassword,
    devDb,
    adminDatabaseUrl:
      env.ADMIN_DATABASE_URL ??
      `postgres://${pgUser}:${pgPassword}@localhost:${pgPort}/${devDb}`,
    migratorDatabaseUrl:
      env.MIGRATOR_DATABASE_URL ??
      `postgres://migrator:${migratorPassword}@localhost:${pgPort}/${devDb}`,
    appDatabaseUrl:
      env.DATABASE_URL ??
      `postgres://app_user:${appUserPassword}@localhost:${pgPort}/${devDb}`,
    workerDatabaseUrl:
      env.WORKER_DATABASE_URL ??
      `postgres://worker_user:${workerPassword}@localhost:${pgPort}/${devDb}`,
    migratorPassword,
    appUserPassword,
    workerPassword,
    webPort,
    apiPort,
    betterAuthSecret,
    appOrigin: env.APP_ORIGIN ?? `http://localhost:${webPort}`,
    apiInternalUrl: env.API_INTERNAL_URL ?? `http://127.0.0.1:${apiPort}`,
  };
}

const children = [];

function spawnChild(label, command, args, cwd, env) {
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const forward = (stream, write) => {
    let buffer = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        write(`[${label}] ${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout.write.bind(process.stdout));
  forward(child.stderr, process.stderr.write.bind(process.stderr));
  child.on("exit", (code, signal) => {
    process.stdout.write(`[${label}] exited (code=${code} signal=${signal})\n`);
  });
  children.push({ label, child });
  return child;
}

function shutdown() {
  for (const { child } of children) {
    if (!child.killed) child.kill("SIGTERM");
  }
  // Give children a moment, then force.
  setTimeout(() => {
    for (const { child } of children) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(0);
  }, 1500).unref();
}

async function dev() {
  const d = devDefaults();

  // 1. Postgres substitute: reuse anything already listening on the port.
  if (await isPortOpen(Number(d.pgPort))) {
    process.stdout.write(`[pg] reusing server on 127.0.0.1:${d.pgPort}\n`);
  } else {
    process.stdout.write(`[pg] starting embedded-postgres on ${d.pgPort}\n`);
    spawnChild(
      "pg",
      process.execPath,
      [path.join(ROOT, "node_modules/.bin/tsx"), "packages/database/src/scripts/start-embedded.ts"],
      ROOT,
      { ...process.env },
    );
    const ready = await waitForPort(Number(d.pgPort), "127.0.0.1", 60_000);
    if (!ready) {
      process.stderr.write("[pg] embedded postgres did not become ready\n");
      process.exit(1);
    }
  }

  // 2. One-time admin bootstrap (idempotent) — never part of migrations.
  runScript(
    "bootstrap",
    ["tsx", "packages/database/src/cli/bootstrap.ts"],
    {
      ...process.env,
      ADMIN_DATABASE_URL: d.adminDatabaseUrl,
      MIGRATOR_PASSWORD: d.migratorPassword,
      APP_USER_PASSWORD: d.appUserPassword,
      WORKER_PASSWORD: d.workerPassword,
    },
  );

  // 3. Migrations run as the migrator role (idempotent).
  runScript("migrate", ["tsx", "packages/database/src/cli/migrate.ts"], {
    ...process.env,
    MIGRATOR_DATABASE_URL: d.migratorDatabaseUrl,
  });

  // 3.5 pg-boss schema DDL as the migrator + worker_user DML grants
  //     (dev companion step; production: a migration owns both — ADR 0003).
  const pgbossInstall = spawnSync(
    "pnpm",
    ["--filter", "@form/worker", "exec", "tsx", "src/install-pgboss.ts"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        ADMIN_DATABASE_URL: d.adminDatabaseUrl,
        MIGRATOR_DATABASE_URL: d.migratorDatabaseUrl,
        WORKER_PASSWORD: d.workerPassword,
      },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
    },
  );
  if (pgbossInstall.status !== 0) {
    process.stderr.write(
      `[pgboss-install] failed (exit ${pgbossInstall.status})\n${pgbossInstall.stderr ?? ""}\n`,
    );
    process.exit(pgbossInstall.status ?? 1);
  }

  // 4. Dev SMTP sink (Mailpit substitute).
  spawnChild("mail", process.execPath, [path.join(ROOT, "scripts/mail-sink.mjs")], ROOT, {
    ...buildChildEnv("sink", process.env),
  });

  // 5. Application children with allowlisted environments.
  spawnChild("api", "pnpm", ["--filter", "@form/api", "dev"], ROOT, {
    ...buildChildEnv("api", {
      ...process.env,
      NODE_ENV: "development",
      PORT: d.apiPort,
      DATABASE_URL: d.appDatabaseUrl,
      APP_ORIGIN: d.appOrigin,
      BETTER_AUTH_SECRET: d.betterAuthSecret,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    }),
  });

  spawnChild("worker", "pnpm", ["--filter", "@form/worker", "dev"], ROOT, {
    ...buildChildEnv("worker", {
      ...process.env,
      NODE_ENV: "development",
      WORKER_DATABASE_URL: d.workerDatabaseUrl,
      LOG_LEVEL: process.env.LOG_LEVEL ?? "info",
    }),
  });

  spawnChild("web", "pnpm", ["--filter", "@form/web", "dev"], ROOT, {
    ...buildChildEnv("web", {
      ...process.env,
      NODE_ENV: "development",
      PORT: d.webPort,
      APP_ORIGIN: d.appOrigin,
      API_INTERNAL_URL: d.apiInternalUrl,
      API_INTERNAL_PORT: d.apiPort,
      NEXT_TELEMETRY_DISABLED: "1",
    }),
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isMain =
  process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain && process.argv.includes("--dev")) {
  dev().catch((err) => {
    process.stderr.write(`[supervisor] ${err?.stack ?? err}\n`);
    process.exit(1);
  });
} else if (isMain) {
  process.stdout.write(
    "Usage: node scripts/supervisor.mjs --dev\n(loads embedded Postgres + bootstrap + migrations + web/api/worker/sink)\n",
  );
}



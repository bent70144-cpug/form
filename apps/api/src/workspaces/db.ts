/**
 * DI token for the request-path Postgres pool (app_user, tenant-query guard
 * armed via @form/database's createPool). The API process receives the POOLED
 * application URL through env `DATABASE_URL` (spec: "the app uses the pooled
 * URL, while the migrator and pg-boss use the direct URL"). The pool is built
 * in app.ts (or injected by tests) and registered in AppModule.withAuth.
 */
export const APP_POOL = "APP_POOL";

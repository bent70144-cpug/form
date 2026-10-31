export {
  EMBEDDED_PG,
  adminUrl,
  ensureEmbeddedPostgres,
  stopEmbeddedPostgres,
  embeddedPgOwnerPid,
  isPostgresReachable,
  type EmbeddedPgHandle,
} from "./embedded";
export {
  TEST_PASSWORDS,
  testRoleUrl,
  ensureBootstrapped,
  createScratchDatabase,
  dropDatabase,
  type BootstrappedUrls,
} from "./fixture";
export { default as embeddedPostgresGlobalSetup } from "./vitest-global-setup";

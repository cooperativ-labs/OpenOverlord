export type { Auth, AuthDatabaseConfig, CreateAuthOptions } from './config.js';
export { authDatabaseFromAdapter, createAuth, githubOAuthConfigFromEnv } from './config.js';
export type { AuthDomainDatabase, PostgresQueryExecutor } from './database.js';
export { getActorForSession } from './session.js';
export {
  DEFAULT_USER_TOKEN_TTL_DAYS,
  generateUserTokenSecret,
  getActorForToken,
  hashUserTokenSecret,
  listActiveTokenScopeGrants,
  resolveUserTokenProfileId,
  USER_TOKEN_HASH_ALGORITHM,
  USER_TOKEN_PREFIX,
  verifyUserToken
} from './token.js';

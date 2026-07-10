import { ENV_PROFILE, REPO_ROOT } from './env-profile.ts';
import { loadRepoEnvForProfile } from './load-repo-env.ts';

// Load profile env files before auth/CORS read BETTER_AUTH_URL, BACKEND_URL, or
// OVERLORD_BACKEND_URL. Explicit runtime exports still win (see load-repo-env.ts).
loadRepoEnvForProfile(REPO_ROOT, ENV_PROFILE);

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { type EnvProfile } from '../cli/src/env.ts';

// This module ships at `backend` in the source tree and is bundled
// elsewhere in production, so its own location distinguishes the two layouts.
const here = path.dirname(fileURLToPath(import.meta.url));

/** Repo root inferred from this module's source location (`backend` -> up one). */
export const REPO_ROOT = path.resolve(here, '..');

/**
 * Source-vs-bundled env profile, shared by every server entry module so the
 * detection lives in one place. The source backend runs from `backend` and
 * reads `.env.local`; the bundled production server runs from elsewhere and reads
 * `.env.prod`. Mirrors the CLI's `detectCliEnvProfile` (installed = production), so
 * the dev-only `OVERLORD_BACKEND_URL_DEV` can never reach a production server.
 */
export const ENV_PROFILE: EnvProfile =
  here === path.join(REPO_ROOT, 'backend') ? 'development' : 'production';

/** Git-ignored local runtime data (SQLite database + object storage). See root `.gitignore`. */
export const LOCAL_DATA_DIR = 'database/.local';

export const DEFAULT_DATABASE_PATH = `${LOCAL_DATA_DIR}/Overlord.sqlite`;

export const LOCAL_STORAGE_DIR = `${LOCAL_DATA_DIR}/storage`;

export const LOCAL_STORAGE_BUCKET_PATHS = {
  attachments: `${LOCAL_STORAGE_DIR}/attachments`,
  'user-images': `${LOCAL_STORAGE_DIR}/user-images`,
  'workspace-images': `${LOCAL_STORAGE_DIR}/workspace-images`
} as const;

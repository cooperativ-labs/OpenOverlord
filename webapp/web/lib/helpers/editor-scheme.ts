export const DEFAULT_EDITOR_SCHEME = 'vscode';

export const EDITOR_SCHEME_OPTIONS = [
  { value: 'vscode', label: 'VS Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'windsurf', label: 'Windsurf' },
  { value: 'zed', label: 'Zed' },
  { value: 'sublime', label: 'Sublime Text' },
  { value: 'textmate', label: 'TextMate' },
  { value: 'jetbrains', label: 'JetBrains IDEs' }
] as const;

export type EditorSchemeValue = (typeof EDITOR_SCHEME_OPTIONS)[number]['value'];

const EDITOR_SCHEME_MAP: Record<EditorSchemeValue, string> = {
  vscode: 'vscode://file',
  cursor: 'cursor://file',
  windsurf: 'windsurf://file',
  zed: 'zed://file',
  sublime: 'subl://open?url=file://',
  textmate: 'txmt://open?url=file://',
  jetbrains: 'idea://open?file='
};

const LEGACY_EDITOR_SCHEME_MAP: Record<string, string> = {
  idea: EDITOR_SCHEME_MAP.jetbrains,
  intellij: EDITOR_SCHEME_MAP.jetbrains,
  phpstorm: EDITOR_SCHEME_MAP.jetbrains,
  webstorm: EDITOR_SCHEME_MAP.jetbrains
};

function isEditorSchemeValue(value: string): value is EditorSchemeValue {
  return value in EDITOR_SCHEME_MAP;
}

/** Resolve a saved editor preference (a short key or a legacy product name) to its URI scheme prefix. */
export function normalizeEditorScheme(value?: string | null): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return EDITOR_SCHEME_MAP[DEFAULT_EDITOR_SCHEME];
  }

  const normalized = trimmed.toLowerCase();
  if (isEditorSchemeValue(normalized)) {
    return EDITOR_SCHEME_MAP[normalized];
  }

  if (normalized in LEGACY_EDITOR_SCHEME_MAP) {
    return LEGACY_EDITOR_SCHEME_MAP[normalized];
  }

  return trimmed;
}

export function getEditorSchemeLabel(value: string | null | undefined): string {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return 'VS Code';
  const match = EDITOR_SCHEME_OPTIONS.find(option => option.value === normalized);
  if (match) return match.label;
  if (normalized in LEGACY_EDITOR_SCHEME_MAP) return 'JetBrains IDEs';
  return value?.trim() ?? 'VS Code';
}

/** Brand icon metadata for a supported editor scheme. */
export interface EditorSchemeIconMeta {
  /** Public asset path served from `webapp/public`. */
  src: string;
  /** Whether the icon should be inverted in dark mode (monochrome marks). */
  invertDark: boolean;
}

const EDITOR_SCHEME_ICONS: Partial<Record<EditorSchemeValue, EditorSchemeIconMeta>> = {
  vscode: { src: '/images/icons/vscode-logo.webp', invertDark: false },
  cursor: { src: '/images/icons/cursor.svg', invertDark: true },
  windsurf: { src: '/images/icons/windsurf-logo.png', invertDark: true }
};

function normalizeEditorSchemeKey(value?: string | null): EditorSchemeValue {
  const normalized = value?.trim().toLowerCase();
  if (normalized && isEditorSchemeValue(normalized)) {
    return normalized;
  }
  return DEFAULT_EDITOR_SCHEME;
}

/** Resolve an editor scheme's icon metadata. Returns null when no icon is mapped. */
export function getEditorSchemeIcon(value?: string | null): EditorSchemeIconMeta | null {
  const key = normalizeEditorSchemeKey(value);
  return EDITOR_SCHEME_ICONS[key] ?? null;
}

function toUriPath(absolutePath: string): string {
  const normalized = absolutePath.replace(/\\/g, '/');
  return /^[A-Za-z]:\//.test(normalized) ? `/${normalized}` : normalized;
}

function toFileUrl(absolutePath: string): string {
  return `file://${toUriPath(absolutePath)}`;
}

export function buildEditorFileHref(absolutePath: string, value?: string | null): string {
  const scheme = normalizeEditorScheme(value);
  const uriPath = encodeURI(toUriPath(absolutePath));

  switch (scheme) {
    case EDITOR_SCHEME_MAP.sublime:
    case EDITOR_SCHEME_MAP.textmate:
      return `${scheme}${encodeURIComponent(toFileUrl(absolutePath))}`;
    case EDITOR_SCHEME_MAP.jetbrains:
      return `${scheme}${encodeURIComponent(absolutePath)}`;
    default:
      return `${scheme}${uriPath}`;
  }
}

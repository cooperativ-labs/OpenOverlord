import { useEffect, useState } from 'react';

import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';
import {
  DEFAULT_EDITOR_SCHEME,
  EDITOR_SCHEME_OPTIONS,
  getEditorSchemeLabel
} from '@/lib/helpers/editor-scheme';
import { useProfile, useUpdateProfile } from '@/lib/queries';

type IdePageProps = {
  open: boolean;
};

export function IdePage({ open }: IdePageProps) {
  const profile = useProfile();
  const updateProfile = useUpdateProfile();

  const [editorScheme, setEditorScheme] = useState(DEFAULT_EDITOR_SCHEME);
  const [saved, setSaved] = useState(DEFAULT_EDITOR_SCHEME);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const value = profile.data?.editorScheme ?? DEFAULT_EDITOR_SCHEME;
    setEditorScheme(value);
    setSaved(value);
  }, [profile.data?.editorScheme]);

  if (!open) return null;

  if (profile.isLoading && !profile.data) {
    return <p className="text-sm text-muted-foreground">Loading IDE settings…</p>;
  }

  if (profile.isError || !profile.data) {
    return (
      <p className="text-sm text-destructive">
        {(profile.error as Error | undefined)?.message ?? 'IDE settings are unavailable right now.'}
      </p>
    );
  }

  async function handleSave() {
    if (editorScheme === saved) return;
    setSaveState('loading');
    setError(null);
    try {
      await updateProfile.mutateAsync({ editorScheme });
      setSaved(editorScheme);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(err instanceof Error ? err.message : 'Failed to save your IDE preference.');
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">IDE</h2>
        <p className="text-sm text-muted-foreground">
          Choose the editor Overlord should use to open files and artifacts for you.
        </p>
      </div>

      <div className="max-w-xl space-y-2">
        <Label htmlFor="editor-scheme-select">Preferred IDE</Label>
        <Select
          value={editorScheme}
          onValueChange={value => setEditorScheme(value ?? DEFAULT_EDITOR_SCHEME)}
        >
          <SelectTrigger id="editor-scheme-select">
            <SelectValue placeholder="Select an IDE">
              {getEditorSchemeLabel(editorScheme)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EDITOR_SCHEME_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          File links will open in {getEditorSchemeLabel(editorScheme)}.
        </p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <div className="flex justify-end">
          <LoadingButton
            buttonState={saveState}
            setButtonState={setSaveState}
            text="Save IDE"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            variant="outline"
            onClick={handleSave}
            disabled={editorScheme === saved}
          />
        </div>
      </div>
    </div>
  );
}

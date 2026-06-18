import { useEffect, useState } from 'react';

import { Label } from '@/components/ui/label';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';
import { Textarea } from '@/components/ui/textarea';
import { useProfile, useUpdateProfile } from '@/lib/queries';

type CustomizationsPageProps = {
  open: boolean;
};

export function CustomizationsPage({ open }: CustomizationsPageProps) {
  const profile = useProfile();

  if (!open) return null;

  if (profile.isLoading && !profile.data) {
    return <p className="text-sm text-muted-foreground">Loading customizations…</p>;
  }

  if (profile.isError || !profile.data) {
    return (
      <p className="text-sm text-destructive">
        {(profile.error as Error | undefined)?.message ??
          'Customization settings are unavailable right now.'}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Customizations</h2>
        <p className="text-sm text-muted-foreground">
          Personal instructions appended to every agent prompt when you launch work from Overlord.
        </p>
      </div>

      <AgentInstructionsField value={profile.data.agentInstructions ?? ''} />
    </div>
  );
}

function AgentInstructionsField({ value }: { value: string }) {
  const updateProfile = useUpdateProfile();
  const [draft, setDraft] = useState(value);
  const [saved, setSaved] = useState(value);
  const [saveState, setSaveState] = useState<ButtonLoadingState>('default');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(value);
    setSaved(value);
  }, [value]);

  async function handleSave() {
    const trimmed = draft.trim();
    if (trimmed === saved.trim()) return;

    setSaveState('loading');
    setError(null);
    try {
      await updateProfile.mutateAsync({ agentInstructions: trimmed || null });
      setSaved(trimmed);
      setDraft(trimmed);
      setSaveState('success');
    } catch (err) {
      setSaveState('error');
      setError(
        err instanceof Error ? err.message : 'Failed to save custom agent instructions.'
      );
    }
  }

  return (
    <div className="grid max-w-2xl gap-2">
      <Label htmlFor="agent-instructions">Custom agent instructions</Label>
      <Textarea
        id="agent-instructions"
        value={draft}
        placeholder="e.g. Always run tests before delivering. Prefer small, focused commits."
        rows={10}
        className="min-h-40 resize-y"
        onChange={e => setDraft(e.target.value)}
        disabled={saveState === 'loading'}
      />
      <div className="flex items-center gap-2">
        <LoadingButton
          buttonState={saveState}
          setButtonState={setSaveState}
          text="Save"
          loadingText="Saving…"
          successText="Saved"
          errorText="Retry"
          reset
          size="sm"
          variant="outline"
          onClick={handleSave}
        />
        {draft.trim() !== saved.trim() ? (
          <p className="text-xs text-muted-foreground">Unsaved changes</p>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        These instructions are included in the Additional Instructions section of the prompt context
        for every ticket you attach to.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}

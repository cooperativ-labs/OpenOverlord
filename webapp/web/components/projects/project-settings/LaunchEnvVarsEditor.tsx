import { Plus, Trash2 } from 'lucide-react';
import {
  type ClipboardEvent,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState
} from 'react';

import {
  createEnvVarRow,
  DEFAULT_ENV_VAR_KEY,
  type EnvVarRow,
  envVarsEqual,
  envVarsFromRows,
  isEnvVarPasteText,
  mergeEnvVarPasteIntoRows,
  rowsFromEnvVars
} from '@/components/projects/project-settings/launch-settings-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { ButtonLoadingState } from '@/components/ui/loading-button';
import { LoadingButton } from '@/components/ui/loading-button';

export type LaunchEnvVarsEditorHandle = {
  insertToken: (token: string) => void;
  focus: () => void;
};

type LaunchEnvVarsEditorProps = {
  savedEnvVars: Record<string, string>;
  disabled?: boolean;
  saveState: ButtonLoadingState;
  setSaveState: (state: ButtonLoadingState) => void;
  error: string | null;
  setError: (error: string | null) => void;
  onSave: (vars: Record<string, string>) => Promise<void>;
};

export const LaunchEnvVarsEditor = forwardRef<LaunchEnvVarsEditorHandle, LaunchEnvVarsEditorProps>(
  function LaunchEnvVarsEditor(
    { savedEnvVars, disabled = false, saveState, setSaveState, error, setError, onSave },
    ref
  ) {
    const [rows, setRows] = useState<EnvVarRow[]>(() => rowsFromEnvVars(savedEnvVars));
    const [focusedRowIndex, setFocusedRowIndex] = useState(0);
    const firstInputRef = useRef<HTMLInputElement | null>(null);

    const currentVars = envVarsFromRows(rows);
    const dirty = !envVarsEqual(currentVars, savedEnvVars);

    useEffect(() => {
      setRows(rowsFromEnvVars(savedEnvVars));
    }, [savedEnvVars]);

    useImperativeHandle(ref, () => ({
      insertToken: (token: string) => {
        setRows(prev => {
          const index = Math.min(focusedRowIndex, prev.length - 1);
          const row = prev[index] ?? createEnvVarRow();
          const nextKey = row.key.trim() || DEFAULT_ENV_VAR_KEY;
          const nextValue = row.value.trim() ? `${row.value}${token}` : token;
          return prev.map((entry, entryIndex) =>
            entryIndex === index ? { ...entry, key: nextKey, value: nextValue } : entry
          );
        });
        setError(null);
        if (saveState === 'error') setSaveState('default');
      },
      focus: () => {
        firstInputRef.current?.focus();
      }
    }));

    async function persistRows(nextRows: EnvVarRow[]) {
      const nextVars = envVarsFromRows(nextRows);
      setSaveState('loading');
      setError(null);
      try {
        await onSave(nextVars);
        setSaveState('success');
      } catch (saveError) {
        setSaveState('error');
        setError(
          saveError instanceof Error
            ? saveError.message
            : 'Failed to update launch environment variables.'
        );
      }
    }

    async function handleManualSave() {
      if (!dirty) return;
      await persistRows(rows);
    }

    function updateRow({
      rowIndex,
      key,
      value
    }: {
      rowIndex: number;
      key?: string;
      value?: string;
    }) {
      setRows(prev =>
        prev.map((row, index) =>
          index === rowIndex
            ? {
                ...row,
                ...(key !== undefined ? { key } : {}),
                ...(value !== undefined ? { value } : {})
              }
            : row
        )
      );
      setError(null);
      if (saveState === 'error') setSaveState('default');
    }

    function removeRow(rowIndex: number) {
      setRows(prev => {
        const next = prev.filter((_, index) => index !== rowIndex);
        return next.length > 0 ? next : [createEnvVarRow()];
      });
      setError(null);
      if (saveState === 'error') setSaveState('default');
    }

    function addRow() {
      setRows(prev => [...prev, createEnvVarRow()]);
    }

    async function handlePaste({
      event,
      rowIndex
    }: {
      event: ClipboardEvent<HTMLInputElement>;
      rowIndex: number;
    }) {
      const text = event.clipboardData.getData('text');
      if (!isEnvVarPasteText(text)) return;

      const merged = mergeEnvVarPasteIntoRows({ rows, rowIndex, text });
      if (!merged) {
        setError('Paste KEY=value lines, one variable per line.');
        setSaveState('error');
        event.preventDefault();
        return;
      }

      event.preventDefault();
      setRows(merged);
      await persistRows(merged);
    }

    const inputsDisabled = disabled || saveState === 'loading';

    return (
      <div className="grid max-w-2xl gap-2">
        <p className="text-xs text-muted-foreground">
          Exported before pre-launch commands and the agent run. Paste multiple{' '}
          <code className="font-mono">KEY=value</code> lines to add and save them at once. Values
          may include <code className="font-mono">{'{VARIABLE}'}</code> placeholders from the
          library below.
        </p>

        <div className="overflow-hidden rounded-lg border border-border">
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_2rem] gap-2 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
            <span>Key</span>
            <span>Value</span>
            <span className="sr-only">Remove</span>
          </div>

          <div className="divide-y divide-border">
            {rows.map((row, rowIndex) => (
              <div
                key={row.id}
                className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_2rem] items-center gap-2 px-3 py-2"
              >
                <Input
                  ref={rowIndex === 0 ? firstInputRef : undefined}
                  value={row.key}
                  onChange={event => updateRow({ rowIndex, key: event.target.value })}
                  onFocus={() => setFocusedRowIndex(rowIndex)}
                  onPaste={event => void handlePaste({ event, rowIndex })}
                  placeholder="AGENT_POD_EXTRA_ALLOWED_PATHS"
                  className="h-8 font-mono text-xs"
                  disabled={inputsDisabled}
                  aria-label={`Environment variable key ${rowIndex + 1}`}
                />
                <Input
                  value={row.value}
                  onChange={event => updateRow({ rowIndex, value: event.target.value })}
                  onFocus={() => setFocusedRowIndex(rowIndex)}
                  onPaste={event => void handlePaste({ event, rowIndex })}
                  placeholder="{OVERLORD_PROJECT_RESOURCES_PATHS_CSV}"
                  className="h-8 font-mono text-xs"
                  disabled={inputsDisabled}
                  aria-label={`Environment variable value ${rowIndex + 1}`}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="text-muted-foreground"
                  onClick={() => removeRow(rowIndex)}
                  disabled={inputsDisabled}
                  aria-label={`Remove environment variable ${rowIndex + 1}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>

          <div className="border-t border-border px-3 py-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-xs"
              onClick={addRow}
              disabled={inputsDisabled}
            >
              <Plus className="size-3.5" />
              Add variable
            </Button>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <LoadingButton
            buttonState={saveState}
            setButtonState={setSaveState}
            text="Save variables"
            loadingText="Saving…"
            successText="Saved"
            errorText="Retry"
            reset
            size="sm"
            variant="outline"
            disabled={!dirty || inputsDisabled}
            onClick={() => void handleManualSave()}
          />
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    );
  }
);

import {
  type AgentModelSelection,
  AgentModelSelector
} from '@/components/objectives/AgentModelSelector.tsx';

import type { AgentCatalogDto, AgentLaunchConfigDto } from '../../../shared/contract.ts';

type AgentModelPickerPanelProps = {
  catalog: AgentCatalogDto;
  selection: AgentModelSelection;
  onChange: (selection: AgentModelSelection) => void;
  agentConfigs: Record<string, AgentLaunchConfigDto>;
  onLaunchConfigCommit: (agentKey: string, config: AgentLaunchConfigDto) => void;
};

/**
 * Renders AgentModelSelector in the document flow (like ProjectPickerPanel)
 * instead of a floating Popover. The quick-task window is a small, fixed
 * BrowserWindow that resizes to match its own content (see
 * desktop/src/quick-task-window.ts setQuickTaskWindowBounds) — a portal-based
 * popover would be clipped at the window's OS-level bounds instead of growing
 * it, so the selector has to live in-flow like the project picker does.
 */
export function AgentModelPickerPanel({
  catalog,
  selection,
  onChange,
  agentConfigs,
  onLaunchConfigCommit
}: AgentModelPickerPanelProps) {
  return (
    <div className="electron-no-drag rounded-xl border bg-background/95 p-2 shadow-lg backdrop-blur-md">
      <AgentModelSelector
        catalog={catalog}
        value={selection}
        onChange={onChange}
        agentConfigs={agentConfigs}
        onLaunchConfigCommit={onLaunchConfigCommit}
        launchConfigSourceHint="Saved to your launch config for this machine."
      />
    </div>
  );
}

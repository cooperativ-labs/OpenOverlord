import { getAgentIcon } from '../../lib/helpers/agent-icons.ts';
import { cn } from '../../lib/utils.ts';

type AgentIconProps = {
  /** Connector agent key (`claude`, `codex`, `cursor`, …). */
  agentKey: string;
  /** Rendered width/height in px. Defaults to 16. */
  size?: number;
  className?: string;
  /** `alt` text for the image. */
  alt?: string;
};

/**
 * Renders an agent's brand icon, centralizing the easy-to-forget
 * `invertDark ? 'dark:invert' : ''` dark-mode rule. Returns `null` when no icon
 * can be resolved for the given agent key.
 */
export function AgentIcon({ agentKey, size = 16, className, alt }: AgentIconProps) {
  const icon = getAgentIcon(agentKey);
  if (!icon) return null;

  return (
    <img
      src={icon.src}
      alt={alt ?? ''}
      width={size}
      height={size}
      className={cn('shrink-0', icon.invertDark ? 'dark:invert' : '', className)}
    />
  );
}

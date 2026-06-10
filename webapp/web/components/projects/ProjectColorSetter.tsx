import { useEffect, useState } from 'react';

import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const PRESET_PROJECT_COLORS = [
  '#fecdd3',
  '#fed7aa',
  '#fde68a',
  '#bef264',
  '#99f6e4',
  '#bae6fd',
  '#fda4af',
  '#fdba74',
  '#fcd34d',
  '#a3e635',
  '#5eead4',
  '#7dd3fc',
  '#fb7185',
  '#f97316',
  '#f59e0b',
  '#84cc16',
  '#2dd4bf',
  '#38bdf8',
  '#e11d48',
  '#c2410c',
  '#b45309',
  '#4d7c0f',
  '#0f766e',
  '#0369a1'
];

/** Default project color (first preset). Use for new projects and placeholders. */
export const DEFAULT_PROJECT_COLOR = PRESET_PROJECT_COLORS[0];

const hexColorPattern = /^#?([0-9a-fA-F]{6})$/;

export function toHexColor(value: string): string | null {
  const trimmed = value.trim();
  const withHash = trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
  return hexColorPattern.test(withHash) ? withHash.toLowerCase() : null;
}

type ProjectColorSetterProps = {
  value: string;
  onSelect: (color: string) => void;
  className?: string;
};

export function ProjectColorSetter({ value, onSelect, className }: ProjectColorSetterProps) {
  const [hexInput, setHexInput] = useState(value);

  useEffect(() => {
    setHexInput(value);
  }, [value]);

  function handleHexSubmit() {
    const color = toHexColor(hexInput);
    if (color) onSelect(color);
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex flex-wrap gap-1.5">
        {PRESET_PROJECT_COLORS.map(color => {
          const isActive = color.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              aria-label={`Select color ${color}`}
              aria-pressed={isActive}
              className={cn(
                'h-6 w-6 rounded-full border transition-transform hover:scale-110',
                isActive
                  ? 'ring-2 ring-ring ring-offset-2 ring-offset-background'
                  : 'border-border/60'
              )}
              style={{ backgroundColor: color }}
              onClick={() => onSelect(color)}
            />
          );
        })}
      </div>
      <Input
        value={hexInput}
        onChange={e => setHexInput(e.target.value)}
        onBlur={handleHexSubmit}
        onKeyDown={e => {
          if (e.key === 'Enter') handleHexSubmit();
        }}
        placeholder={DEFAULT_PROJECT_COLOR}
        spellCheck={false}
        className="h-7 w-24 text-xs"
      />
    </div>
  );
}

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
    <div className={cn('w-fit space-y-2', className)}>
      <div className="grid grid-cols-6 gap-1">
        {PRESET_PROJECT_COLORS.map(color => {
          const isActive = color.toLowerCase() === value.toLowerCase();
          return (
            <button
              key={color}
              type="button"
              className={cn(
                'h-4 w-4 rounded-[4px] border transition ring-offset-1',
                isActive ? 'ring-2 ring-primary' : 'hover:ring-2 hover:ring-primary/50'
              )}
              style={{ backgroundColor: color, borderColor: color }}
              aria-label={`Use color ${color}`}
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
        className="mt-2 h-7 w-24 text-xs"
      />
    </div>
  );
}

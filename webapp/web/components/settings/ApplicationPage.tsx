import { useTheme } from 'next-themes';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select';

const themeOptions = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
] as const;

export function ApplicationPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium">Application</h2>
        <p className="text-sm text-muted-foreground">
          Appearance preferences for this browser session.
        </p>
      </div>

      <div className="max-w-md space-y-2">
        <Label htmlFor="theme-select">Theme</Label>
        <Select
          value={theme ?? 'system'}
          onValueChange={value => {
            if (value) setTheme(value);
          }}
        >
          <SelectTrigger id="theme-select" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {themeOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          System follows your OS appearance setting. Stored locally in this browser.
        </p>
      </div>
    </div>
  );
}

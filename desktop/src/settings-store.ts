import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

type StoreData = Record<string, unknown>;

let data: StoreData | null = null;

function getStorePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load(): StoreData {
  if (data) return data;
  try {
    const raw = fs.readFileSync(getStorePath(), 'utf-8');
    data = JSON.parse(raw) as StoreData;
  } catch {
    data = {};
  }
  return data;
}

function save(): void {
  if (!data) return;
  const dir = path.dirname(getStorePath());
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(getStorePath(), JSON.stringify(data, null, 2));
}

export const store = {
  get(key: string, defaultValue?: unknown): unknown {
    const current = load();
    return key in current ? current[key] : defaultValue;
  },
  set(key: string, value: unknown): void {
    const current = load();
    current[key] = value;
    save();
  }
};

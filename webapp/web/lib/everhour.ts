import { useEffect, useState } from 'react';

/**
 * Format a duration (seconds) as a compact clock, `H:MM:SS` once an hour has
 * elapsed, otherwise `M:SS`. Used by the running-timer displays.
 */
export function formatClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${minutes}:${ss}`;
}

/**
 * Format a duration (seconds) as human hours/minutes, e.g. `1h 30m`, `45m`, or
 * `0m`. Used for logged time records and totals.
 */
export function formatHoursMinutes(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.round((s % 3600) / 60);
  if (hours > 0 && minutes > 0) return `${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * Parse a human duration string into seconds. Accepts `1h 30m`, `1.5h`, `90m`,
 * `1:30` (h:mm), or a bare number of minutes. Returns `null` when unparseable or
 * non-positive.
 */
export function parseDurationToSeconds(raw: string): number | null {
  const input = raw.trim().toLowerCase();
  if (!input) return null;

  // `h:mm` clock form.
  const clock = input.match(/^(\d+):([0-5]?\d)$/);
  if (clock) {
    const seconds = Number(clock[1]) * 3600 + Number(clock[2]) * 60;
    return seconds > 0 ? seconds : null;
  }

  // `1h 30m` / `1.5h` / `90m` unit form.
  const unit = input.match(/^(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?$/);
  if (unit && (unit[1] || unit[2])) {
    const hours = unit[1] ? Number(unit[1]) : 0;
    const minutes = unit[2] ? Number(unit[2]) : 0;
    const seconds = Math.round(hours * 3600 + minutes * 60);
    return seconds > 0 ? seconds : null;
  }

  // Bare number → minutes.
  const bare = Number(input);
  if (Number.isFinite(bare) && bare > 0) return Math.round(bare * 60);
  return null;
}

/**
 * Live-ticking seconds for a running timer. Seeds from the server-reported
 * `baseSeconds` captured at `baseAtMs` (ms epoch) and advances one second at a
 * time while `running`. Re-seeds whenever the inputs change so a refetch snaps
 * the display back to authoritative server time.
 */
export function useLiveSeconds(baseSeconds: number, baseAtMs: number, running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running, baseSeconds, baseAtMs]);
  if (!running) return baseSeconds;
  return baseSeconds + Math.max(0, Math.floor((now - baseAtMs) / 1000));
}

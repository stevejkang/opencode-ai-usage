import type { Percent0to100, UnixMs } from "./types";
import { toUnixMs } from "./types";

const DEFAULT_BAR_WIDTH = 14;
const FILLED_CHAR = "█";
const EMPTY_CHAR = "░";
const THIN_FILLED_CHAR = "━";
const THIN_EMPTY_CHAR = "─";
const HIGH_USAGE_COLOR = "#E07A3A";
const WARNING_COLOR = "#F0A875";
const DANGER_COLOR = "#D32F2F";

/** Format a reset timestamp as a relative duration string (e.g. "3h 16m", "2d 5h"). Returns "—" for null. */
export function formatRelativeTime(resetsAt: UnixMs | null, now?: UnixMs): string {
  if (resetsAt == null) return "—";
  const nowMs = now ?? toUnixMs(Date.now());
  const diffMs = resetsAt - nowMs;
  if (diffMs <= 0) return "now";

  const totalMinutes = Math.floor(diffMs / 60_000);
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d ${hours}h`;
  if (totalHours > 0) return `${totalHours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return "now";
}

/** Format a percentage value as an integer string with "%" suffix. Returns "—%" for null. */
export function formatPercentage(percent: Percent0to100 | null): string {
  if (percent == null) return "—%";
  return `${Math.round(percent)}%`;
}

/** Build a block progress bar (█░). Returns filled/empty segments for separate TUI coloring. */
export function formatBar(
  percent: Percent0to100 | null,
  width: number = DEFAULT_BAR_WIDTH,
): { filled: string; empty: string } {
  if (percent == null) {
    return { filled: "", empty: EMPTY_CHAR.repeat(width) };
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  return {
    filled: FILLED_CHAR.repeat(filledCount),
    empty: EMPTY_CHAR.repeat(width - filledCount),
  };
}

/** Build a thin progress bar (━─). Returns filled/empty segments for separate TUI coloring. */
export function formatThinBar(
  percent: Percent0to100 | null,
  width: number = DEFAULT_BAR_WIDTH,
): { filled: string; empty: string } {
  if (percent == null) {
    return { filled: "", empty: THIN_EMPTY_CHAR.repeat(width) };
  }
  const clamped = Math.max(0, Math.min(100, percent));
  const filledCount = Math.round((clamped / 100) * width);
  return {
    filled: THIN_FILLED_CHAR.repeat(filledCount),
    empty: THIN_EMPTY_CHAR.repeat(width - filledCount),
  };
}

/**
 * Map a percentage to a display color based on usage severity.
 *
 * Normal mode (used%): ≥80 high-usage (#E07A3A), ≥51 warning (#F0A875), else default.
 * Inverted mode (remaining%): ≤20 danger (#D32F2F), ≤49 warning (#F0A875), else default.
 * Danger uses #D32F2F — #E07A3A is the Claude header brand color and must not double as danger.
 */
export function getPercentColor(
  percent: Percent0to100 | null,
  defaultColor: string,
  inverted?: boolean,
): string {
  if (percent == null) return defaultColor;

  if (inverted) {
    if (percent <= 20) return DANGER_COLOR;
    if (percent <= 49) return WARNING_COLOR;
    return defaultColor;
  }

  if (percent >= 80) return HIGH_USAGE_COLOR;
  if (percent >= 51) return WARNING_COLOR;
  return defaultColor;
}

export interface CreditDisplay {
  usedStr: string;
  remainingStr: string;
  percent: number;
  isInactive: boolean;
}

/** Format credit usage for Claude expanded view. Returns null when data is unavailable. */
export function formatCreditDisplay(
  usedCents: number | null | undefined,
  limitCents: number | null | undefined,
  currency: string | null | undefined,
): CreditDisplay | null {
  if (usedCents == null || limitCents == null) return null;

  const symbol = currency === "USD" ? "$" : (currency ?? "$");
  const usedStr = `${symbol}${(usedCents / 100).toFixed(2)}`;
  const remCents = Math.max(0, limitCents - usedCents);
  const remainingStr = `${symbol}${(remCents / 100).toFixed(2)}`;
  const isInactive = usedCents === 0 && limitCents === 0;
  const percent = limitCents > 0 ? (usedCents / limitCents) * 100 : 100;
  return { usedStr, remainingStr, percent, isInactive };
}

/**
 * Map a window duration in minutes to a human-readable label.
 *
 * OpenAI-only: Claude assigns provider-specific labels during normalize
 * because its seven-day windows would all collide as "Weekly".
 */
export function formatWindowLabel(durationMins: number | null | undefined): string {
  if (durationMins == null) return "Unknown";
  if (durationMins === 60) return "Hourly";
  if (durationMins === 300) return "Session";
  if (durationMins === 1440) return "Daily";
  if (durationMins === 10080) return "Weekly";
  if (durationMins === 43200) return "Monthly";

  const totalHours = Math.floor(durationMins / 60);
  const days = Math.floor(totalHours / 24);
  if (days > 0) return `${days}d`;
  if (totalHours > 0) return `${totalHours}h`;
  return `${durationMins}m`;
}

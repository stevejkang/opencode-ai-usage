import type { Percent0to100, RefreshDiagnostics } from "./types";
import { toPercent } from "./types";

export type SectionVisibility =
  | { kind: "loading" }
  | { kind: "data"; staleText: string | null }
  | { kind: "error"; message: string };

export function computeSectionVisibility(input: {
  hasData: boolean;
  error: string | null;
  lastFetchedAt: number | null;
  refreshIntervalMs: number;
  now: number;
}): SectionVisibility {
  if (!input.hasData && input.error === null) return { kind: "loading" };
  if (!input.hasData && input.error !== null) return { kind: "error", message: input.error };
  const staleText = computeStaleText(input.lastFetchedAt!, input.refreshIntervalMs, input.now);
  return { kind: "data", staleText };
}

export function computeStaleText(
  lastFetchedAt: number,
  refreshIntervalMs: number,
  now: number,
): string | null {
  const ageMs = now - lastFetchedAt;
  if (ageMs <= 2 * refreshIntervalMs) return null;

  const totalMinutes = Math.floor(ageMs / 60_000);
  if (totalMinutes < 1) return "updated <1m ago";

  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const minutes = totalMinutes % 60;

  if (days > 0) return `updated ${days}d ${hours}h ago`;
  if (totalHours > 0) return `updated ${totalHours}h ${minutes}m ago`;
  return `updated ${totalMinutes}m ago`;
}

const OVERDUE_GRACE_MS = 5_000;

/** Lists the reasons the sidebar data is (or stays) stale, for the debug log. */
export function explainStale(input: {
  diag: RefreshDiagnostics;
  refreshIntervalMs: number;
  now: number;
}): string[] {
  const { diag, refreshIntervalMs, now } = input;
  const reasons: string[] = [];
  const phaseAgeS = Math.round((now - diag.phaseSince) / 1000);

  if (diag.phase === "fetching" && now - diag.phaseSince > refreshIntervalMs) {
    reasons.push(`fetch in flight for ${phaseAgeS}s without completing`);
  }
  if (diag.phase === "rate-limit-wait") {
    reasons.push(`rate limited (429), waiting for retry-after for ${phaseAgeS}s`);
  }
  if (diag.phase === "backoff-wait") {
    reasons.push(`waiting out shared fetch backoff after failures for ${phaseAgeS}s`);
  }
  if (diag.phase === "lock-wait") {
    reasons.push(`another process holds the fetch lock for ${phaseAgeS}s`);
  }
  if (diag.phase === "retry-wait") {
    reasons.push(`backing off after transient error for ${phaseAgeS}s`);
  }
  if (
    diag.phase === "scheduled" &&
    diag.nextCycleAt !== null &&
    now - diag.nextCycleAt > OVERDUE_GRACE_MS
  ) {
    reasons.push(`next cycle overdue by ${Math.round((now - diag.nextCycleAt) / 1000)}s`);
  }
  if (diag.lastError !== null) {
    reasons.push(
      `last ${diag.consecutiveFailures} fetch(es) failed: ${diag.lastError}; keeping ${diag.dataSource} data`,
    );
  }
  if (diag.lastSuccessAt === null && diag.dataSource !== "fetch") {
    reasons.push(
      `no successful fetch in this process yet; data from ${diag.dataSource} written by pid ${diag.dataWriterPid ?? "unknown"}`,
    );
  }
  if (reasons.length === 0) reasons.push("no fetch failure or stuck phase detected");
  return reasons;
}

export function computeDisplayPercent(
  percent: Percent0to100 | null,
  showRemaining: boolean,
): Percent0to100 | null {
  if (percent === null) return null;
  return showRemaining ? toPercent(100 - percent) : percent;
}

export function computeCountdown(expectedLoadTimeS: number, elapsedS: number): number {
  return Math.max(0, expectedLoadTimeS - elapsedS);
}

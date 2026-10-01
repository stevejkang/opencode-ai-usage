import { toPercent } from "../src/types";
import type { Percent0to100, RefreshDiagnostics } from "../src/types";
import {
  computeSectionVisibility,
  computeStaleText,
  computeDisplayPercent,
  computeCountdown,
  explainStale,
} from "../src/tui-logic";

const INTERVAL_MS = 60_000;
const BASE_TIME = 1_700_000_000_000;

describe("computeSectionVisibility", () => {
  it("returns loading when no data and no error", () => {
    const result = computeSectionVisibility({
      hasData: false,
      error: null,
      lastFetchedAt: null,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result).toEqual({ kind: "loading" });
  });

  it("returns error when no data and error present", () => {
    const result = computeSectionVisibility({
      hasData: false,
      error: "Network failure",
      lastFetchedAt: null,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result).toEqual({ kind: "error", message: "Network failure" });
  });

  it("returns data with no stale text when fresh", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: null,
      lastFetchedAt: BASE_TIME - 30_000,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result).toEqual({ kind: "data", staleText: null });
  });

  it("returns data with stale text when age exceeds 2x interval", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: null,
      lastFetchedAt: BASE_TIME - 180_000,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.staleText).toBe("updated 3m ago");
    }
  });

  it("returns data with stale text on error with cached data", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: "Fetch failed",
      lastFetchedAt: BASE_TIME - 300_000,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.staleText).toBe("updated 5m ago");
    }
  });

  it("returns data without stale text when exactly at 2x threshold", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: null,
      lastFetchedAt: BASE_TIME - 2 * INTERVAL_MS,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result).toEqual({ kind: "data", staleText: null });
  });

  it("returns data with stale text 1ms past 2x threshold", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: null,
      lastFetchedAt: BASE_TIME - 2 * INTERVAL_MS - 1,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result.kind).toBe("data");
    if (result.kind === "data") {
      expect(result.staleText).toBe("updated 2m ago");
    }
  });

  it("returns data fresh when data exists and error with recent cache", () => {
    const result = computeSectionVisibility({
      hasData: true,
      error: "Temporary error",
      lastFetchedAt: BASE_TIME - 50_000,
      refreshIntervalMs: INTERVAL_MS,
      now: BASE_TIME,
    });
    expect(result).toEqual({ kind: "data", staleText: null });
  });
});

describe("computeStaleText", () => {
  it("returns null when age is within 2x interval", () => {
    expect(computeStaleText(BASE_TIME - 60_000, INTERVAL_MS, BASE_TIME)).toBeNull();
  });

  it("returns null at exactly 2x interval boundary", () => {
    expect(computeStaleText(BASE_TIME - 120_000, INTERVAL_MS, BASE_TIME)).toBeNull();
  });

  it("returns minute-based text just past threshold", () => {
    expect(computeStaleText(BASE_TIME - 120_001, INTERVAL_MS, BASE_TIME)).toBe("updated 2m ago");
  });

  it("returns '<1m ago' when age exceeds threshold with sub-minute floor", () => {
    expect(computeStaleText(BASE_TIME - 60_100, 30_000, BASE_TIME)).toBe("updated 1m ago");
  });

  it("returns '<1m ago' when age just past threshold but under 60s total", () => {
    expect(computeStaleText(BASE_TIME - 10_500, 5_000, BASE_TIME)).toBe("updated <1m ago");
  });

  it("returns minute count for older data", () => {
    expect(computeStaleText(BASE_TIME - 360_000, INTERVAL_MS, BASE_TIME)).toBe("updated 6m ago");
  });

  it("returns large minute count for very old data", () => {
    expect(computeStaleText(BASE_TIME - 3_000_000, INTERVAL_MS, BASE_TIME)).toBe("updated 50m ago");
  });

  it("formats hours and minutes for 90-minute age", () => {
    expect(computeStaleText(BASE_TIME - 90 * 60_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 1h 30m ago",
    );
  });

  it("formats hours with zero minutes", () => {
    expect(computeStaleText(BASE_TIME - 2 * 3_600_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 2h 0m ago",
    );
  });

  it("formats at exactly 1 hour boundary", () => {
    expect(computeStaleText(BASE_TIME - 3_600_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 1h 0m ago",
    );
  });

  it("formats days and hours for 25-hour age", () => {
    expect(computeStaleText(BASE_TIME - 25 * 3_600_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 1d 1h ago",
    );
  });

  it("formats days with zero hours", () => {
    expect(computeStaleText(BASE_TIME - 48 * 3_600_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 2d 0h ago",
    );
  });

  it("formats at exactly 1 day boundary", () => {
    expect(computeStaleText(BASE_TIME - 24 * 3_600_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 1d 0h ago",
    );
  });

  it("formats 780m as 13h 0m", () => {
    expect(computeStaleText(BASE_TIME - 780 * 60_000, INTERVAL_MS, BASE_TIME)).toBe(
      "updated 13h 0m ago",
    );
  });
});

describe("computeDisplayPercent", () => {
  it("returns percent as-is when showRemaining is false", () => {
    const p = toPercent(31) as Percent0to100;
    expect(computeDisplayPercent(p, false)).toBe(p);
  });

  it("returns 100-percent when showRemaining is true", () => {
    const p = toPercent(31) as Percent0to100;
    const result = computeDisplayPercent(p, true)!;
    expect(result).toBe(69);
  });

  it("returns null for null input regardless of showRemaining", () => {
    expect(computeDisplayPercent(null, false)).toBeNull();
    expect(computeDisplayPercent(null, true)).toBeNull();
  });

  it("clamps inverted result to 0-100", () => {
    const zero = toPercent(0) as Percent0to100;
    expect(computeDisplayPercent(zero, true)).toBe(100);

    const full = toPercent(100) as Percent0to100;
    expect(computeDisplayPercent(full, true)).toBe(0);
  });

  it("handles boundary value 50", () => {
    const half = toPercent(50) as Percent0to100;
    expect(computeDisplayPercent(half, true)).toBe(50);
  });
});

describe("computeCountdown", () => {
  it("returns remaining seconds", () => {
    expect(computeCountdown(25, 10)).toBe(15);
  });

  it("floors at zero", () => {
    expect(computeCountdown(10, 15)).toBe(0);
  });

  it("returns expected when elapsed is zero", () => {
    expect(computeCountdown(8, 0)).toBe(8);
  });

  it("returns zero when elapsed equals expected", () => {
    expect(computeCountdown(16, 16)).toBe(0);
  });
});

describe("default export shape", () => {
  it("tui-logic exports all pure helpers", async () => {
    const mod = await import("../src/tui-logic");
    expect(typeof mod.computeSectionVisibility).toBe("function");
    expect(typeof mod.computeStaleText).toBe("function");
    expect(typeof mod.computeDisplayPercent).toBe("function");
    expect(typeof mod.computeCountdown).toBe("function");
  });
});

describe("explainStale", () => {
  function makeDiag(overrides: Partial<RefreshDiagnostics> = {}): RefreshDiagnostics {
    return {
      phase: "scheduled",
      phaseSince: BASE_TIME,
      nextCycleAt: BASE_TIME + INTERVAL_MS,
      cycles: 1,
      lastSuccessAt: BASE_TIME,
      lastErrorAt: null,
      lastError: null,
      consecutiveFailures: 0,
      dataSource: "fetch",
      dataWriterPid: 123,
      ...overrides,
    };
  }

  const explain = (diag: RefreshDiagnostics, now: number) =>
    explainStale({ diag, refreshIntervalMs: INTERVAL_MS, now });

  it("reports a fetch that has been in flight longer than one interval", () => {
    const diag = makeDiag({ phase: "fetching", phaseSince: BASE_TIME, nextCycleAt: null });

    expect(explain(diag, BASE_TIME + 3 * INTERVAL_MS)).toEqual([
      "fetch in flight for 180s without completing",
    ]);
  });

  it("does not flag a fetch that is still within one interval", () => {
    const diag = makeDiag({ phase: "fetching", nextCycleAt: null });

    expect(explain(diag, BASE_TIME + 1_000)).toEqual(["no fetch failure or stuck phase detected"]);
  });

  it("reports rate-limit waits", () => {
    const diag = makeDiag({ phase: "rate-limit-wait", nextCycleAt: null });

    expect(explain(diag, BASE_TIME + 30_000)).toEqual([
      "rate limited (429), waiting for retry-after for 30s",
    ]);
  });

  it("reports shared backoff and fetch lock waits without flagging them overdue", () => {
    expect(explain(makeDiag({ phase: "backoff-wait" }), BASE_TIME + 30_000)).toEqual([
      "waiting out shared fetch backoff after failures for 30s",
    ]);
    expect(explain(makeDiag({ phase: "lock-wait" }), BASE_TIME + 30_000)).toEqual([
      "another process holds the fetch lock for 30s",
    ]);
  });

  it("reports an overdue scheduled cycle", () => {
    const diag = makeDiag();

    expect(explain(diag, BASE_TIME + INTERVAL_MS + 20_000)).toEqual(["next cycle overdue by 20s"]);
  });

  it("reports consecutive failures and cache-seeded data with the writer pid", () => {
    const diag = makeDiag({
      lastSuccessAt: null,
      lastError: "HTTP 401",
      lastErrorAt: BASE_TIME,
      consecutiveFailures: 3,
      dataSource: "cache-seed",
      dataWriterPid: 4242,
    });

    expect(explain(diag, BASE_TIME)).toEqual([
      "last 3 fetch(es) failed: HTTP 401; keeping cache-seed data",
      "no successful fetch in this process yet; data from cache-seed written by pid 4242",
    ]);
  });

  it("reports unknown writer pid for legacy cache entries", () => {
    const diag = makeDiag({ lastSuccessAt: null, dataSource: "cache-seed", dataWriterPid: null });

    expect(explain(diag, BASE_TIME)).toEqual([
      "no successful fetch in this process yet; data from cache-seed written by pid unknown",
    ]);
  });
});

import {
  formatRelativeTime,
  formatPercentage,
  formatBar,
  formatThinBar,
  getPercentColor,
  formatCreditDisplay,
  formatWindowLabel,
} from "../src/format";
import { toUnixMs, toPercent } from "../src/types";

const PINNED_NOW = toUnixMs(1781812800000);

afterEach(() => {
  vi.useRealTimers();
});

// TZ-independence: all calculations are pure ms arithmetic (resetsAt - now).
// No Date formatting or locale operations are involved, so the output is
// identical regardless of process TZ. We verify this by passing explicit
// now values — shifting both endpoints by an arbitrary offset yields the
// same duration string.

describe("formatRelativeTime", () => {
  it("returns '—' for null", () => {
    expect(formatRelativeTime(null)).toBe("—");
  });

  it("returns 'now' when resetsAt equals now", () => {
    expect(formatRelativeTime(PINNED_NOW, PINNED_NOW)).toBe("now");
  });

  it("returns 'now' when resetsAt is in the past", () => {
    expect(formatRelativeTime(toUnixMs(PINNED_NOW - 60_000), PINNED_NOW)).toBe("now");
  });

  it("returns 'now' for sub-minute future", () => {
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + 30_000), PINNED_NOW)).toBe("now");
  });

  it("formats minutes only", () => {
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + 15 * 60_000), PINNED_NOW)).toBe("15m");
  });

  it("formats exactly 1 minute", () => {
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + 60_000), PINNED_NOW)).toBe("1m");
  });

  it("formats hours and minutes", () => {
    const threeH16m = (3 * 60 + 16) * 60_000;
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + threeH16m), PINNED_NOW)).toBe("3h 16m");
  });

  it("formats days and hours", () => {
    const twoD5h = (2 * 24 + 5) * 3_600_000;
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + twoD5h), PINNED_NOW)).toBe("2d 5h");
  });

  it("uses Date.now() when now is omitted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(PINNED_NOW);
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + 2 * 3_600_000))).toBe("2h 0m");
  });

  it("is timezone-independent (same diff yields same output)", () => {
    const diff = 3 * 3_600_000;
    const offset = 9 * 3_600_000;
    expect(formatRelativeTime(toUnixMs(PINNED_NOW + diff), PINNED_NOW)).toBe("3h 0m");
    expect(
      formatRelativeTime(toUnixMs(PINNED_NOW + offset + diff), toUnixMs(PINNED_NOW + offset)),
    ).toBe("3h 0m");
  });
});

// ---------------------------------------------------------------------------
// formatPercentage
// ---------------------------------------------------------------------------

describe("formatPercentage", () => {
  it("returns '—%' for null", () => {
    expect(formatPercentage(null)).toBe("—%");
  });

  it("formats integer percentage", () => {
    expect(formatPercentage(toPercent(31))).toBe("31%");
  });

  it("rounds fractional values", () => {
    expect(formatPercentage(toPercent(31.6))).toBe("32%");
  });

  it("handles 0%", () => {
    expect(formatPercentage(toPercent(0))).toBe("0%");
  });

  it("handles 100%", () => {
    expect(formatPercentage(toPercent(100))).toBe("100%");
  });
});

// ---------------------------------------------------------------------------
// formatBar
// ---------------------------------------------------------------------------

describe("formatBar", () => {
  it("returns all-empty bar for null", () => {
    const bar = formatBar(null);
    expect(bar.filled).toBe("");
    expect(bar.empty).toBe("░".repeat(14));
  });

  it("returns all-empty bar for 0%", () => {
    const bar = formatBar(toPercent(0));
    expect(bar.filled).toBe("");
    expect(bar.empty).toBe("░".repeat(14));
  });

  it("returns all-filled bar for 100%", () => {
    const bar = formatBar(toPercent(100));
    expect(bar.filled).toBe("█".repeat(14));
    expect(bar.empty).toBe("");
  });

  it("splits proportionally", () => {
    const bar = formatBar(toPercent(50));
    expect(bar.filled.length + bar.empty.length).toBe(14);
    expect(bar.filled).toBe("█".repeat(7));
    expect(bar.empty).toBe("░".repeat(7));
  });

  it("respects custom width", () => {
    const bar = formatBar(toPercent(50), 10);
    expect(bar.filled.length + bar.empty.length).toBe(10);
    expect(bar.filled).toBe("█".repeat(5));
  });

  it("returns all-empty for null with custom width", () => {
    const bar = formatBar(null, 8);
    expect(bar.filled).toBe("");
    expect(bar.empty).toBe("░".repeat(8));
  });
});

// ---------------------------------------------------------------------------
// formatThinBar
// ---------------------------------------------------------------------------

describe("formatThinBar", () => {
  it("returns all-empty thin bar for null", () => {
    const bar = formatThinBar(null);
    expect(bar.filled).toBe("");
    expect(bar.empty).toBe("─".repeat(14));
  });

  it("returns all-empty thin bar for 0%", () => {
    const bar = formatThinBar(toPercent(0));
    expect(bar.filled).toBe("");
    expect(bar.empty).toBe("─".repeat(14));
  });

  it("returns all-filled thin bar for 100%", () => {
    const bar = formatThinBar(toPercent(100));
    expect(bar.filled).toBe("━".repeat(14));
    expect(bar.empty).toBe("");
  });

  it("splits proportionally", () => {
    const bar = formatThinBar(toPercent(50));
    expect(bar.filled).toBe("━".repeat(7));
    expect(bar.empty).toBe("─".repeat(7));
  });

  it("respects custom width", () => {
    const bar = formatThinBar(toPercent(50), 10);
    expect(bar.filled.length + bar.empty.length).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// getPercentColor — normal mode
// ---------------------------------------------------------------------------

describe("getPercentColor (normal mode)", () => {
  const DEFAULT = "#FFFFFF";

  it("returns default for null", () => {
    expect(getPercentColor(null, DEFAULT)).toBe(DEFAULT);
  });

  it("returns default for 0%", () => {
    expect(getPercentColor(toPercent(0), DEFAULT)).toBe(DEFAULT);
  });

  it("returns default for 50%", () => {
    expect(getPercentColor(toPercent(50), DEFAULT)).toBe(DEFAULT);
  });

  it("returns warning at 51%", () => {
    expect(getPercentColor(toPercent(51), DEFAULT)).toBe("#F0A875");
  });

  it("returns warning at 79%", () => {
    expect(getPercentColor(toPercent(79), DEFAULT)).toBe("#F0A875");
  });

  it("returns high-usage at 80%", () => {
    expect(getPercentColor(toPercent(80), DEFAULT)).toBe("#E07A3A");
  });

  it("returns high-usage at 100%", () => {
    expect(getPercentColor(toPercent(100), DEFAULT)).toBe("#E07A3A");
  });
});

// ---------------------------------------------------------------------------
// getPercentColor — inverted mode (showRemaining)
// ---------------------------------------------------------------------------

describe("getPercentColor (inverted mode)", () => {
  const DEFAULT = "#FFFFFF";

  it("returns default for null", () => {
    expect(getPercentColor(null, DEFAULT, true)).toBe(DEFAULT);
  });

  it("returns danger (#D32F2F) at 0% remaining", () => {
    expect(getPercentColor(toPercent(0), DEFAULT, true)).toBe("#D32F2F");
  });

  it("returns danger at 20% remaining", () => {
    expect(getPercentColor(toPercent(20), DEFAULT, true)).toBe("#D32F2F");
  });

  it("returns warning at 21% remaining", () => {
    expect(getPercentColor(toPercent(21), DEFAULT, true)).toBe("#F0A875");
  });

  it("returns warning at 49% remaining", () => {
    expect(getPercentColor(toPercent(49), DEFAULT, true)).toBe("#F0A875");
  });

  it("returns default at 50% remaining", () => {
    expect(getPercentColor(toPercent(50), DEFAULT, true)).toBe(DEFAULT);
  });

  it("returns default at 100% remaining", () => {
    expect(getPercentColor(toPercent(100), DEFAULT, true)).toBe(DEFAULT);
  });
});

// ---------------------------------------------------------------------------
// formatCreditDisplay
// ---------------------------------------------------------------------------

describe("formatCreditDisplay", () => {
  it("returns null for null usedCents", () => {
    expect(formatCreditDisplay(null, 1000, "USD")).toBeNull();
  });

  it("returns null for null limitCents", () => {
    expect(formatCreditDisplay(500, null, "USD")).toBeNull();
  });

  it("returns null for undefined usedCents", () => {
    expect(formatCreditDisplay(undefined, 1000, "USD")).toBeNull();
  });

  it("returns null for undefined limitCents", () => {
    expect(formatCreditDisplay(500, undefined, "USD")).toBeNull();
  });

  it("formats USD credits", () => {
    const result = formatCreditDisplay(1550, 5000, "USD");
    expect(result).not.toBeNull();
    expect(result!.usedStr).toBe("$15.50");
    expect(result!.remainingStr).toBe("$34.50");
    expect(result!.percent).toBeCloseTo(31);
    expect(result!.isInactive).toBe(false);
  });

  it("defaults to $ symbol for null currency", () => {
    const result = formatCreditDisplay(100, 1000, null);
    expect(result!.usedStr).toBe("$1.00");
  });

  it("defaults to $ symbol for undefined currency", () => {
    const result = formatCreditDisplay(100, 1000, undefined);
    expect(result!.usedStr).toBe("$1.00");
  });

  it("uses non-USD currency symbol as-is", () => {
    const result = formatCreditDisplay(100, 1000, "€");
    expect(result!.usedStr).toBe("€1.00");
  });

  it("clamps remaining to 0 when overused", () => {
    const result = formatCreditDisplay(6000, 5000, "USD");
    expect(result!.remainingStr).toBe("$0.00");
  });

  it("marks inactive when both are 0", () => {
    const result = formatCreditDisplay(0, 0, "USD");
    expect(result!.isInactive).toBe(true);
    expect(result!.percent).toBe(100);
  });

  it("calculates 100% when limit is 0 but used is non-zero", () => {
    const result = formatCreditDisplay(100, 0, "USD");
    expect(result!.percent).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// formatWindowLabel
// ---------------------------------------------------------------------------

describe("formatWindowLabel", () => {
  it("returns 'Unknown' for null", () => {
    expect(formatWindowLabel(null)).toBe("Unknown");
  });

  it("returns 'Unknown' for undefined", () => {
    expect(formatWindowLabel(undefined)).toBe("Unknown");
  });

  it("maps 60 minutes to 'Hourly'", () => {
    expect(formatWindowLabel(60)).toBe("Hourly");
  });

  it("maps 300 minutes to 'Session'", () => {
    expect(formatWindowLabel(300)).toBe("Session");
  });

  it("maps 1440 minutes to 'Daily'", () => {
    expect(formatWindowLabel(1440)).toBe("Daily");
  });

  it("maps 10080 minutes to 'Weekly'", () => {
    expect(formatWindowLabel(10080)).toBe("Weekly");
  });

  it("maps 43200 minutes to 'Monthly'", () => {
    expect(formatWindowLabel(43200)).toBe("Monthly");
  });

  it("formats arbitrary days", () => {
    expect(formatWindowLabel(2880)).toBe("2d");
  });

  it("formats arbitrary hours", () => {
    expect(formatWindowLabel(180)).toBe("3h");
  });

  it("formats arbitrary minutes", () => {
    expect(formatWindowLabel(45)).toBe("45m");
  });
});

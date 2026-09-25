import { ProviderFetchError } from "../../../src/types";
import { fetchOAuthUsage, fetchOAuthProfile } from "../../../src/providers/claude/oauth-client";

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): typeof globalThis.fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  });
}

function networkErrorFetch(): typeof globalThis.fetch {
  return vi.fn().mockRejectedValue(new TypeError("fetch failed"));
}

const signal = new AbortController().signal;

describe("fetchOAuthUsage", () => {
  it("sends correct headers and parses successful response", async () => {
    const fetcher = mockFetch(200, {
      five_hour: { utilization: 31, resets_at: "2025-01-01T12:00:00Z" },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      seven_day_oauth_apps: null,
      seven_day_cowork: null,
      extra_usage: null,
      limits: null,
    });

    const result = await fetchOAuthUsage("tok_test", fetcher, signal);
    expect(result.fiveHour).toEqual({
      utilization: 31,
      resetsAt: "2025-01-01T12:00:00Z",
    });

    const call = (fetcher as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(call[1].headers.Authorization).toBe("Bearer tok_test");
    expect(call[1].headers["anthropic-beta"]).toBe("oauth-2025-04-20");
    expect(call[1].signal).toBe(signal);
  });

  it("converts snake_case keys to camelCase", async () => {
    const fetcher = mockFetch(200, {
      five_hour: { utilization: 10, resets_at: null },
      seven_day: { utilization: 20, resets_at: null },
      seven_day_sonnet: null,
      seven_day_opus: null,
      seven_day_oauth_apps: { utilization: 7, resets_at: null },
      seven_day_cowork: null,
      extra_usage: { is_enabled: true, monthly_limit: 100 },
      limits: [{ kind: "session", used_percentage: 45, is_active: true }],
    });

    const result = await fetchOAuthUsage("tok", fetcher, signal);
    expect(result.fiveHour?.utilization).toBe(10);
    expect(result.sevenDayOAuthApps?.utilization).toBe(7);
    expect(result.extraUsage?.isEnabled).toBe(true);
  });

  it("normalizes usedPercentage to utilization", async () => {
    const fetcher = mockFetch(200, {
      five_hour: { used_percentage: 55, resets_at: null },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      seven_day_oauth_apps: null,
      seven_day_cowork: { used_percentage: 18, resets_at: "2025-02-01T00:00:00Z" },
      extra_usage: null,
      limits: [{ used_percentage: 30, kind: "session" }],
    });

    const result = await fetchOAuthUsage("tok", fetcher, signal);
    expect(result.fiveHour?.utilization).toBe(55);
    expect(result.sevenDayCowork?.utilization).toBe(18);
    expect(result.limits?.[0]?.percent).toBe(30);
  });

  it("maps limit scope model display_name and defaults missing percent to 0", async () => {
    const fetcher = mockFetch(200, {
      five_hour: null,
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      seven_day_oauth_apps: null,
      seven_day_cowork: null,
      extra_usage: null,
      limits: [
        {
          kind: "weekly_scoped",
          scope: { model: { id: "fable", display_name: "Fable" }, surface: null },
        },
      ],
    });

    const result = await fetchOAuthUsage("tok", fetcher, signal);
    expect(result.limits?.[0]?.scope?.model?.displayName).toBe("Fable");
    expect(result.limits?.[0]?.percent).toBe(0);
  });

  it("throws ProviderFetchError with retryAfterS on 429", async () => {
    const fetcher = mockFetch(429, {}, { "retry-after": "120" });

    await expect(fetchOAuthUsage("tok", fetcher, signal)).rejects.toThrow(ProviderFetchError);

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "http", status: 429, retryAfterS: 120 });
    }
  });

  it("defaults retryAfterS to 60 when header missing on 429", async () => {
    const fetcher = mockFetch(429, {});

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "http", status: 429, retryAfterS: 60 });
    }
  });

  it("throws ProviderFetchError on 401", async () => {
    const fetcher = mockFetch(401, {});

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "http", status: 401 });
    }
  });

  it("throws ProviderFetchError on 403", async () => {
    const fetcher = mockFetch(403, {});

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "http", status: 403 });
    }
  });

  it("throws ProviderFetchError on 500", async () => {
    const fetcher = mockFetch(500, {});

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "http", status: 500 });
    }
  });

  it("throws network error on fetch failure", async () => {
    const fetcher = networkErrorFetch();

    try {
      await fetchOAuthUsage("tok", fetcher, signal);
    } catch (e) {
      const err = e as ProviderFetchError;
      expect(err.info).toEqual({ kind: "network" });
    }
  });
});

describe("fetchOAuthProfile", () => {
  it("maps claude_max organization_type to Max", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
      organization: { organization_type: "claude_max" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: "Max" });
  });

  it("maps claude_pro organization_type to Pro", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
      organization: { organization_type: "claude_pro" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: "Pro" });
  });

  it("maps claude_team organization_type to Team", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
      organization: { organization_type: "claude_team" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: "Team" });
  });

  it("maps claude_enterprise organization_type to Enterprise", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
      organization: { organization_type: "claude_enterprise" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: "Enterprise" });
  });

  it("returns null plan for unknown organization_type", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
      organization: { organization_type: "something_else" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: null });
  });

  it("returns null plan when no organization present", async () => {
    const fetcher = mockFetch(200, {
      account: { email: "user@example.com" },
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "user@example.com", plan: null });
  });

  it("extracts email from top-level email field", async () => {
    const fetcher = mockFetch(200, {
      email: "top@example.com",
    });

    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toEqual({ email: "top@example.com", plan: null });
  });

  it("returns null when no email present", async () => {
    const fetcher = mockFetch(200, { account: {} });
    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toBeNull();
  });

  it("returns null on non-200 response", async () => {
    const fetcher = mockFetch(401, {});
    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toBeNull();
  });

  it("returns null on network error", async () => {
    const fetcher = networkErrorFetch();
    const result = await fetchOAuthProfile("tok", fetcher, signal);
    expect(result).toBeNull();
  });
});

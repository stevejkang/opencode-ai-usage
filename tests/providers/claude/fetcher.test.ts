import type { ProviderDeps } from "../../../src/types";
import { ProviderFetchError } from "../../../src/types";
import { detect, fetchUsage, limitLabel } from "../../../src/providers/claude/fetcher";

const NOW = 1_700_000_000_000;
const FUTURE = NOW + 60 * 60 * 1000;

const USAGE_RESPONSE_RAW = {
  five_hour: { utilization: 31, resets_at: "2025-01-15T12:00:00Z" },
  seven_day: { utilization: 11, resets_at: "2025-01-20T00:00:00Z" },
  seven_day_sonnet: { utilization: 5, resets_at: "2025-01-20T00:00:00Z" },
  seven_day_opus: null,
  seven_day_oauth_apps: null,
  seven_day_cowork: null,
  nimbus_quill: { utilization: 42, resets_at: "2025-01-20T00:00:00Z" },
  extra_usage: {
    is_enabled: true,
    monthly_limit: 100,
    used_credits: 25,
    utilization: 25,
    currency: "USD",
  },
  limits: [
    {
      kind: "session",
      group: "session",
      percent: 31,
      severity: "normal",
      resets_at: "2025-01-15T12:00:00Z",
      scope: null,
      is_active: true,
    },
  ],
};

const PROFILE_RESPONSE_RAW = {
  account: { email: "user@test.com" },
  organization: { organization_type: "claude_pro" },
};

function successFetch(): typeof globalThis.fetch {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("/usage")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(USAGE_RESPONSE_RAW),
      });
    }
    if (String(url).includes("/profile")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
      });
    }
    return Promise.reject(new Error("unexpected url"));
  });
}

function failFetch(): typeof globalThis.fetch {
  return vi.fn().mockRejectedValue(new TypeError("network error"));
}

function makeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    exec: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
    readFile: vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    }),
    fetch: successFetch(),
    now: () => NOW,
    homedir: () => "/home/test",
    ...overrides,
  };
}

function validCredentialsJson(): string {
  return JSON.stringify({
    accessToken: "tok_cred",
    refreshToken: "ref_cred",
    expiresAt: FUTURE,
    scopes: ["user:profile"],
  });
}

function openCodeAuthJson(expired = false): string {
  return JSON.stringify({
    anthropic: {
      access: "tok_oc",
      refresh: "ref_oc",
      expires: expired ? NOW - 1000 : FUTURE,
    },
  });
}

const signal = new AbortController().signal;
const originalPlatform = process.platform;

afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", { value: originalPlatform });
});

describe("detect", () => {
  it("returns available when env token exists", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
    const deps = makeDeps();
    const result = await detect(deps, signal);
    expect(result).toEqual({ available: true });
  });

  it("returns available when credentials file exists", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const deps = makeDeps({
      readFile: vi.fn().mockReturnValue(validCredentialsJson()),
    });
    const result = await detect(deps, signal);
    expect(result).toEqual({ available: true });
  });

  it("returns available when OpenCode auth exists", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    const deps = makeDeps({
      readFile: vi.fn().mockImplementation((path: string) => {
        if (String(path).includes("auth.json")) return openCodeAuthJson();
        throw new Error("ENOENT");
      }),
    });
    const result = await detect(deps, signal);
    expect(result).toEqual({ available: true });
  });

  it("returns available when keychain exists (macOS)", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    Object.defineProperty(process, "platform", { value: "darwin" });

    const keychainData = JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok_kc",
        refreshToken: "ref_kc",
        expiresAt: FUTURE,
        scopes: [],
      },
    });
    const deps = makeDeps({
      readFile: vi.fn().mockImplementation(() => {
        throw new Error("ENOENT");
      }),
      execFile: vi.fn().mockReturnValue(keychainData),
    });
    const result = await detect(deps, signal);
    expect(result).toEqual({ available: true });
  });

  it("returns unavailable when all sources missing", async () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    Object.defineProperty(process, "platform", { value: "linux" });

    const deps = makeDeps({
      readFile: vi.fn().mockImplementation(() => {
        throw new Error("ENOENT");
      }),
    });
    const result = await detect(deps, signal);
    expect(result.available).toBe(false);
  });
});

describe("fetchUsage", () => {
  describe("fallback chain order: keychain → env → credentials → opencode", () => {
    it("uses keychain first on macOS", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      Object.defineProperty(process, "platform", { value: "darwin" });

      const keychainData = JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok_kc",
          refreshToken: "ref_kc",
          expiresAt: FUTURE,
          scopes: [],
        },
      });
      const fetchFn = successFetch();
      const deps = makeDeps({
        fetch: fetchFn,
        execFile: vi.fn().mockReturnValue(keychainData),
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");

      const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
      const usageCall = calls.find((c) => String(c[0]).includes("/usage"));
      expect(usageCall?.[1]?.headers?.Authorization).toBe("Bearer tok_kc");
    });

    it("skips keychain on non-darwin and uses env token", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      Object.defineProperty(process, "platform", { value: "linux" });

      const fetchFn = successFetch();
      const deps = makeDeps({ fetch: fetchFn });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");

      const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
      const usageCall = calls.find((c) => String(c[0]).includes("/usage"));
      expect(usageCall?.[1]?.headers?.Authorization).toBe("Bearer tok_env");
    });

    it("falls back to credentials file when keychain and env missing", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      Object.defineProperty(process, "platform", { value: "linux" });
      const fetchFn = successFetch();
      const deps = makeDeps({
        fetch: fetchFn,
        readFile: vi.fn().mockImplementation((path: string) => {
          if (String(path).includes(".credentials.json")) return validCredentialsJson();
          throw new Error("ENOENT");
        }),
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");

      const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
      const usageCall = calls.find((c) => String(c[0]).includes("/usage"));
      expect(usageCall?.[1]?.headers?.Authorization).toBe("Bearer tok_cred");
    });

    it("falls back to OpenCode auth as last step", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      Object.defineProperty(process, "platform", { value: "linux" });
      const fetchFn = successFetch();
      const deps = makeDeps({
        fetch: fetchFn,
        readFile: vi.fn().mockImplementation((path: string) => {
          if (String(path).includes("auth.json")) return openCodeAuthJson();
          throw new Error("ENOENT");
        }),
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");

      const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
      const usageCall = calls.find((c) => String(c[0]).includes("/usage"));
      expect(usageCall?.[1]?.headers?.Authorization).toBe("Bearer tok_oc");
    });

    it("throws when all sources exhausted", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      Object.defineProperty(process, "platform", { value: "linux" });

      const deps = makeDeps({
        fetch: failFetch(),
        readFile: vi.fn().mockImplementation(() => {
          throw new Error("ENOENT");
        }),
      });

      await expect(fetchUsage(deps, signal)).rejects.toThrow(ProviderFetchError);
    });
  });

  describe("ProviderFetchError propagation", () => {
    it("propagates 429 ProviderFetchError from first step", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "30" }),
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
        });
      });
      const deps = makeDeps({ fetch: fetchFn });

      try {
        await fetchUsage(deps, signal);
        expect.unreachable("should throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderFetchError);
        const err = e as ProviderFetchError;
        expect(err.info).toEqual({
          kind: "http",
          status: 429,
          retryAfterS: 30,
        });
      }
    });

    it("continues fallback chain when earlier source returns 429", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      Object.defineProperty(process, "platform", { value: "darwin" });

      const keychainData = JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok_kc",
          refreshToken: "ref_kc",
          expiresAt: FUTURE,
          scopes: [],
        },
      });

      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation((url: string, opts?: RequestInit) => {
        const auth = (opts?.headers as Record<string, string>)?.Authorization ?? "";
        if (String(url).includes("/usage") && auth.includes("tok_oc")) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ "retry-after": "60" }),
            json: () => Promise.resolve({}),
          });
        }
        if (String(url).includes("/usage")) {
          callCount++;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(USAGE_RESPONSE_RAW),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected url"));
      });

      const deps = makeDeps({
        fetch: fetchFn,
        readFile: vi.fn().mockImplementation((path: string) => {
          if (String(path).includes("auth.json")) {
            return openCodeAuthJson();
          }
          throw new Error("ENOENT");
        }),
        execFile: vi.fn().mockImplementation((...args: unknown[]) => {
          if (String(args[0]) === "/usr/bin/security") return keychainData;
          throw new Error("not found");
        }),
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");
      expect(callCount).toBe(1);

      const calls = (fetchFn as ReturnType<typeof vi.fn>).mock.calls;
      const successCall = calls.find(
        (c) =>
          String(c[0]).includes("/usage") &&
          (c[1] as { headers: Record<string, string> })?.headers?.Authorization === "Bearer tok_kc",
      );
      expect(successCall).toBeDefined();
    });
  });

  describe("token refresh", () => {
    it("refreshes via CLI first when OpenCode token expired", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      let readCount = 0;
      const deps = makeDeps({
        readFile: vi.fn().mockImplementation((path: string) => {
          if (String(path).includes("auth.json")) {
            readCount++;
            if (readCount <= 1) return openCodeAuthJson(true);
            return openCodeAuthJson(false);
          }
          throw new Error("ENOENT");
        }),
        execFile: vi.fn().mockReturnValue(""),
        fetch: successFetch(),
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");
    });

    it("falls back to direct refresh when CLI fails", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("oauth/token")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                access_token: "tok_refreshed",
                expires_in: 28800,
              }),
          });
        }
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(USAGE_RESPONSE_RAW),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected url"));
      });
      const deps = makeDeps({
        readFile: vi.fn().mockImplementation((path: string) => {
          if (String(path).includes("auth.json")) {
            return openCodeAuthJson(true);
          }
          throw new Error("ENOENT");
        }),
        execFile: vi.fn().mockImplementation(() => {
          throw new Error("CLI not found");
        }),
        fetch: fetchFn,
      });

      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");
    });
  });

  describe("normalize", () => {
    it("converts ISO 8601 resetsAt to UnixMs", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const deps = makeDeps({ fetch: successFetch() });
      const result = await fetchUsage(deps, signal);

      const sessionWindow = result.windows.find((w) => w.label === "Session");
      expect(sessionWindow).toBeDefined();
      expect(sessionWindow!.resetsAt).toBe(new Date("2025-01-15T12:00:00Z").getTime());
    });

    it("assigns distinct labels for 7-day windows (fallback path)", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve({ ...USAGE_RESPONSE_RAW, limits: null }),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });
      const deps = makeDeps({ fetch: fetchFn });
      const result = await fetchUsage(deps, signal);

      const labels = result.windows.map((w) => w.label);
      expect(labels).toContain("Session");
      expect(labels).toContain("Weekly");
      expect(labels).toContain("Sonnet");
    });

    it("filters out null windows and skips unknown keys", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const deps = makeDeps({ fetch: successFetch() });
      const result = await fetchUsage(deps, signal);

      expect(result.windows.every((w) => w.label !== "Opus")).toBe(true);
      expect(result.windows.every((w) => w.label !== "nimbus_quill")).toBe(true);
      expect(result.windows.every((w) => w.label !== "nimbusQuill")).toBe(true);
    });

    it("clamps percent to 0-100", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                five_hour: { utilization: 150, resets_at: null },
                seven_day: { utilization: -5, resets_at: null },
                seven_day_sonnet: null,
                seven_day_opus: null,
                seven_day_oauth_apps: null,
                seven_day_cowork: null,
                extra_usage: null,
                limits: null,
              }),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });
      const deps = makeDeps({ fetch: fetchFn });
      const result = await fetchUsage(deps, signal);

      const session = result.windows.find((w) => w.label === "Session");
      const weekly = result.windows.find((w) => w.label === "Weekly");
      expect(session!.percent).toBe(100);
      expect(weekly!.percent).toBe(0);
    });
  });

  describe("limitLabel", () => {
    it("returns Session for kind session", () => {
      expect(limitLabel("session", null)).toBe("Session");
    });

    it("returns Weekly for kind weekly_all", () => {
      expect(limitLabel("weekly_all", null)).toBe("Weekly");
    });

    it("returns model displayName for weekly_scoped with model", () => {
      const scope = { model: { id: "fable", displayName: "Fable" }, surface: null };
      expect(limitLabel("weekly_scoped", scope)).toBe("Fable");
    });

    it("returns kind as fallback for unknown kinds", () => {
      expect(limitLabel("weekly_scoped", null)).toBe("weekly_scoped");
    });

    it("returns kind when scope has null model", () => {
      expect(limitLabel("weekly_scoped", { model: null, surface: null })).toBe("weekly_scoped");
    });
  });

  describe("limits-present normalization", () => {
    function limitsUsageFetch(limits: unknown[]): typeof globalThis.fetch {
      return vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                five_hour: { utilization: 31, resets_at: "2025-01-15T12:00:00Z" },
                seven_day: { utilization: 11, resets_at: "2025-01-20T00:00:00Z" },
                seven_day_sonnet: null,
                seven_day_opus: null,
                seven_day_oauth_apps: null,
                seven_day_cowork: null,
                extra_usage: null,
                limits,
              }),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected url"));
      });
    }

    it("normalizes session/weekly_all/weekly_scoped with model displayName", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "session",
          group: "session",
          percent: 31,
          severity: "normal",
          resets_at: "2025-01-15T12:00:00Z",
          scope: null,
          is_active: true,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 11,
          severity: "normal",
          resets_at: "2025-01-20T00:00:00Z",
          scope: null,
          is_active: true,
        },
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 5,
          severity: "normal",
          resets_at: "2025-01-20T00:00:00Z",
          scope: { model: { id: "fable", display_name: "Fable" }, surface: null },
          is_active: true,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      const labels = result.windows.map((w) => w.label);
      expect(labels).toEqual(["Session", "Weekly", "Fable"]);

      const fable = result.windows.find((w) => w.label === "Fable");
      expect(fable).toBeDefined();
      expect(fable!.percent).toBe(5);
      expect(fable!.isActive).toBe(true);
    });

    it("falls back to kind for weekly_scoped without displayName", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "weekly_scoped",
          group: "weekly",
          percent: 10,
          severity: "normal",
          resets_at: "2025-01-20T00:00:00Z",
          scope: { model: null, surface: null },
          is_active: true,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      expect(result.windows[0].label).toBe("weekly_scoped");
    });

    it("marks inactive when percent is 0 and no resetsAt (ignores API is_active)", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "session",
          group: "session",
          percent: 0,
          severity: "normal",
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      const session = result.windows.find((w) => w.label === "Session");
      expect(session).toBeDefined();
      expect(session!.isActive).toBe(false);
      expect(session!.percent).toBe(0);
      expect(session!.resetsAt).toBeNull();
    });

    it("marks active when percent > 0 even if API is_active is false", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "weekly_all",
          group: "weekly",
          percent: 15,
          severity: "normal",
          resets_at: "2025-01-20T00:00:00Z",
          scope: null,
          is_active: false,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      const weekly = result.windows.find((w) => w.label === "Weekly");
      expect(weekly).toBeDefined();
      expect(weekly!.isActive).toBe(true);
      expect(weekly!.percent).toBe(15);
    });

    it("converts limits resetsAt ISO to UnixMs", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "session",
          group: "session",
          percent: 50,
          severity: "normal",
          resets_at: "2025-01-15T12:00:00Z",
          scope: null,
          is_active: true,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      expect(result.windows[0].resetsAt).toBe(new Date("2025-01-15T12:00:00Z").getTime());
    });

    it("clamps limits percent to 0-100", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const limits = [
        {
          kind: "session",
          group: "session",
          percent: 150,
          severity: "normal",
          resets_at: null,
          scope: null,
          is_active: true,
        },
        {
          kind: "weekly_all",
          group: "weekly",
          percent: -5,
          severity: "normal",
          resets_at: null,
          scope: null,
          is_active: true,
        },
      ];
      const deps = makeDeps({ fetch: limitsUsageFetch(limits) });
      const result = await fetchUsage(deps, signal);

      expect(result.windows[0].percent).toBe(100);
      expect(result.windows[1].percent).toBe(0);
    });
  });

  describe("extras", () => {
    it("populates ClaudeExtras when credits enabled", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const deps = makeDeps({ fetch: successFetch() });
      const result = await fetchUsage(deps, signal);

      expect(result.extras).not.toBeNull();
      expect(result.extras!.extraUsage).toEqual({
        isEnabled: true,
        monthlyLimit: 100,
        usedCredits: 25,
        utilization: 25,
        currency: "USD",
      });
    });

    it("does not include limits in extras", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const deps = makeDeps({ fetch: successFetch() });
      const result = await fetchUsage(deps, signal);

      expect(result.extras).not.toBeNull();
      expect("limits" in result.extras!).toBe(false);
    });

    it("returns null extraUsage when credits disabled", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                ...USAGE_RESPONSE_RAW,
                extra_usage: {
                  is_enabled: false,
                  monthly_limit: 0,
                  used_credits: 0,
                  utilization: 0,
                  currency: "USD",
                },
              }),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });
      const deps = makeDeps({ fetch: fetchFn });
      const result = await fetchUsage(deps, signal);

      expect(result.extras).not.toBeNull();
      expect(result.extras!.extraUsage).toBeNull();
    });

    it("returns null extraUsage when extra_usage is null", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve({ ...USAGE_RESPONSE_RAW, extra_usage: null }),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(PROFILE_RESPONSE_RAW),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });
      const deps = makeDeps({ fetch: fetchFn });
      const result = await fetchUsage(deps, signal);

      expect(result.extras!.extraUsage).toBeNull();
    });
  });

  describe("accountKey", () => {
    it("uses profile email as accountKey", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const deps = makeDeps({ fetch: successFetch() });
      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBe("user@test.com");
    });

    it("returns null accountKey when profile unavailable", async () => {
      vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
      const fetchFn = vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/usage")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers(),
            json: () => Promise.resolve(USAGE_RESPONSE_RAW),
          });
        }
        if (String(url).includes("/profile")) {
          return Promise.resolve({
            ok: false,
            status: 401,
            headers: new Headers(),
            json: () => Promise.resolve({}),
          });
        }
        return Promise.reject(new Error("unexpected"));
      });
      const deps = makeDeps({ fetch: fetchFn });
      const result = await fetchUsage(deps, signal);
      expect(result.accountKey).toBeNull();
    });
  });
});

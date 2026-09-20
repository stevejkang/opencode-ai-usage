import { detect, fetchUsage, readApiKey } from "../../../src/providers/opencode-go/fetcher";
import type { ProviderDeps } from "../../../src/types";

function createFakeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    exec: vi.fn() as unknown as ProviderDeps["exec"],
    execFile: vi.fn() as unknown as ProviderDeps["execFile"],
    spawn: vi.fn() as unknown as ProviderDeps["spawn"],
    readFile: vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    }) as unknown as ProviderDeps["readFile"],
    fetch: vi.fn() as unknown as ProviderDeps["fetch"],
    now: () => Date.now(),
    homedir: () => "/home/test",
    ...overrides,
  };
}

function mockFetch(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): ProviderDeps["fetch"] {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    json: () => Promise.resolve(body),
  }) as unknown as ProviderDeps["fetch"];
}

describe("readApiKey", () => {
  it("reads key from auth.json", () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test-key" } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    expect(readApiKey(deps)).toBe("sk-test-key");
  });

  it("returns null when auth.json is missing", () => {
    const deps = createFakeDeps();
    expect(readApiKey(deps)).toBeNull();
  });

  it("returns null when auth.json has empty key", () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "" } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    expect(readApiKey(deps)).toBeNull();
  });

  it("returns null when auth.json has null key", () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: null } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    expect(readApiKey(deps)).toBeNull();
  });

  it("falls back to OPENCODE_API_KEY env var when auth.json is missing", () => {
    const original = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "env-key-123";
    try {
      const deps = createFakeDeps();
      expect(readApiKey(deps)).toBe("env-key-123");
    } finally {
      if (original === undefined) {
        delete process.env.OPENCODE_API_KEY;
      } else {
        process.env.OPENCODE_API_KEY = original;
      }
    }
  });

  it("prefers auth.json over env var", () => {
    const original = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "env-key";
    try {
      const deps = createFakeDeps({
        readFile: vi
          .fn()
          .mockReturnValue(
            JSON.stringify({ "opencode-go": { type: "api", key: "file-key" } }),
          ) as unknown as ProviderDeps["readFile"],
      });
      expect(readApiKey(deps)).toBe("file-key");
    } finally {
      if (original === undefined) {
        delete process.env.OPENCODE_API_KEY;
      } else {
        process.env.OPENCODE_API_KEY = original;
      }
    }
  });

  it("trims whitespace from key", () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "  sk-key  " } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    expect(readApiKey(deps)).toBe("sk-key");
  });

  it("returns null when opencode-go entry is missing from auth.json", () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ anthropic: { type: "oauth", access: "token" } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    expect(readApiKey(deps)).toBeNull();
  });
});

describe("detect", () => {
  it("returns available when auth.json has opencode-go key", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({ available: true });
  });

  it("returns unavailable when no credentials found", async () => {
    const deps = createFakeDeps();
    const original = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const result = await detect(deps, AbortSignal.abort());
      expect(result).toEqual({
        available: false,
        reason: "No OpenCode Go credentials found",
      });
    } finally {
      if (original !== undefined) {
        process.env.OPENCODE_API_KEY = original;
      }
    }
  });

  it("returns available when OPENCODE_API_KEY env var is set", async () => {
    const original = process.env.OPENCODE_API_KEY;
    process.env.OPENCODE_API_KEY = "env-key";
    try {
      const deps = createFakeDeps();
      const result = await detect(deps, AbortSignal.abort());
      expect(result).toEqual({ available: true });
    } finally {
      if (original === undefined) {
        delete process.env.OPENCODE_API_KEY;
      } else {
        process.env.OPENCODE_API_KEY = original;
      }
    }
  });
});

describe("fetchUsage", () => {
  it("happy path: returns windows from API response", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, {
        usage: {
          rolling: { status: "active", percent: 31, resetsAt: "2025-01-15T12:00:00Z" },
          weekly: { status: "active", percent: 11, resetsAt: "2025-01-20T00:00:00Z" },
          monthly: { status: "active", percent: 5, resetsAt: "2025-02-01T00:00:00Z" },
        },
      }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);

    expect(result.windows).toHaveLength(3);
    expect(result.windows[0]!.label).toBe("Session");
    expect(result.windows[0]!.percent).toBe(31);
    expect(result.windows[1]!.label).toBe("Weekly");
    expect(result.windows[1]!.percent).toBe(11);
    expect(result.windows[2]!.label).toBe("Monthly");
    expect(result.windows[2]!.percent).toBe(5);
    expect(result.extras).toBeNull();
  });

  it("sends Bearer token in Authorization header", async () => {
    const fetchMock = mockFetch(200, { usage: {} });
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-my-key" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: fetchMock,
    });

    await fetchUsage(deps, new AbortController().signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://opencode.ai/zen/go/v1/usage",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-my-key",
        }),
      }),
    );
  });

  it("throws on no credentials", async () => {
    const original = process.env.OPENCODE_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    try {
      const deps = createFakeDeps();
      await expect(fetchUsage(deps, new AbortController().signal)).rejects.toThrow(
        "No OpenCode Go credentials found",
      );
    } finally {
      if (original !== undefined) {
        process.env.OPENCODE_API_KEY = original;
      }
    }
  });

  it("throws on 401 unauthorized", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-bad" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(401, { error: "unauthorized" }),
    });

    await expect(fetchUsage(deps, new AbortController().signal)).rejects.toThrow(
      "OpenCode Go API key rejected (401)",
    );
  });

  it("returns empty windows on 403 (no subscription)", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(403, { error: "forbidden" }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toEqual([]);
  });

  it("throws on 429 rate limit with retry-after", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(429, { error: "rate limited" }, { "retry-after": "30" }),
    });

    await expect(fetchUsage(deps, new AbortController().signal)).rejects.toThrow(
      "Rate limited (429)",
    );
  });

  it("throws on other HTTP errors", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(500, { error: "internal" }),
    });

    await expect(fetchUsage(deps, new AbortController().signal)).rejects.toThrow("HTTP 500");
  });

  it("handles empty usage response", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, { usage: {} }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toEqual([]);
  });

  it("handles null usage field", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, { usage: null }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toEqual([]);
  });

  it("handles partial windows (only rolling)", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, {
        usage: {
          rolling: { percent: 50, resetsAt: "2025-01-15T12:00:00Z" },
        },
      }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.label).toBe("Session");
    expect(result.windows[0]!.percent).toBe(50);
  });

  it("handles null percent in window metric", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, {
        usage: {
          rolling: { status: "active", percent: null, resetsAt: "2025-01-15T12:00:00Z" },
        },
      }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.percent).toBeNull();
  });

  it("parses resetsAt ISO string to UnixMs", async () => {
    const resetsAt = "2025-01-15T12:00:00Z";
    const expectedMs = new Date(resetsAt).getTime();

    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, {
        usage: {
          weekly: { percent: 20, resetsAt },
        },
      }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows[0]!.resetsAt).toBe(expectedMs);
  });

  it("throws network error on fetch failure", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: vi
        .fn()
        .mockRejectedValue(new Error("network down")) as unknown as ProviderDeps["fetch"],
    });

    await expect(fetchUsage(deps, new AbortController().signal)).rejects.toThrow(
      "Network error fetching OpenCode Go usage",
    );
  });

  it("throws abort error when caller signal is aborted", async () => {
    const ac = new AbortController();
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: vi.fn().mockImplementation(() => {
        ac.abort();
        throw new Error("aborted");
      }) as unknown as ProviderDeps["fetch"],
    });

    await expect(fetchUsage(deps, ac.signal)).rejects.toThrow("Fetch aborted");
  });

  it("handles malformed resetsAt string gracefully", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(200, {
        usage: {
          rolling: { percent: 10, resetsAt: "not-a-date" },
        },
      }),
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.resetsAt).toBeNull();
    expect(result.windows[0]!.percent).toBe(10);
  });

  it("defaults retry-after to 60 when header is missing on 429", async () => {
    const deps = createFakeDeps({
      readFile: vi
        .fn()
        .mockReturnValue(
          JSON.stringify({ "opencode-go": { type: "api", key: "sk-test" } }),
        ) as unknown as ProviderDeps["readFile"],
      fetch: mockFetch(429, { error: "rate limited" }),
    });

    try {
      await fetchUsage(deps, new AbortController().signal);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as any).info.retryAfterS).toBe(60);
    }
  });
});

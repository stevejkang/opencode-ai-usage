import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRegistry } from "../../src/registry";
import { createCacheStore } from "../../src/cache";
import { createRefreshLoop } from "../../src/refresh";
import { computeDisplayPercent } from "../../src/tui-logic";
import { getPercentColor } from "../../src/format";
import {
  type FetchResult,
  type ProviderDefinition,
  type ProviderDeps,
  type RefreshState,
  type UsageWindow,
  ProviderFetchError,
  UNKNOWN_ACCOUNT_KEY,
  toPercent,
  toUnixMs,
} from "../../src/types";
import { createClaudeProvider } from "../../src/providers/claude/index";
import { createOpenAIProvider } from "../../src/providers/openai/index";
import { createOpenCodeGoProvider } from "../../src/providers/opencode-go/index";

const FROZEN_NOW = 1_700_000_000_000;

function makeFakeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    exec: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
    readFile: vi.fn().mockImplementation(() => {
      throw new Error("ENOENT");
    }),
    fetch: vi.fn(),
    now: () => FROZEN_NOW,
    homedir: () => "/home/test",
    ...overrides,
  };
}

function makeWindows(...percents: (number | null)[]): UsageWindow[] {
  return percents.map((p, i) => ({
    label: `Window ${i}`,
    percent: p !== null ? toPercent(p) : null,
    resetsAt: toUnixMs(FROZEN_NOW + 3_600_000),
    isActive: true,
  }));
}

function makeFakeProvider(
  id: string,
  fetchImpl: ProviderDefinition["fetch"],
): ProviderDefinition<unknown> {
  return {
    id,
    displayName: `${id} Usage`,
    defaultHeaderColor: id === "claude" ? "#E07A3A" : "#10A37F",
    expectedLoadTimeS: 5,
    defaultRefreshIntervalS: 30,
    detect: vi.fn<ProviderDefinition["detect"]>().mockResolvedValue({ available: true }),
    fetch: fetchImpl,
  };
}

function createStateTracker() {
  const calls: RefreshState[] = [];
  const waiters = new Map<number, (s: RefreshState) => void>();

  return {
    setState: (s: RefreshState) => {
      calls.push(s);
      const waiter = waiters.get(calls.length);
      if (waiter) {
        waiters.delete(calls.length);
        waiter(s);
      }
    },
    calls,
    waitFor: (n: number): Promise<RefreshState> => {
      if (calls.length >= n) return Promise.resolve(calls[n - 1]);
      return new Promise((resolve) => {
        waiters.set(n, resolve);
      });
    },
  };
}

describe("multi-provider integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "integ-"));
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(tmpDir, { recursive: true, force: true });
  });

  describe("registry with multiple providers", () => {
    it("getAll returns all providers registered via real factories", () => {
      const registry = createRegistry([
        createClaudeProvider(),
        createOpenAIProvider(),
        createOpenCodeGoProvider(),
      ]);
      const all = registry.getAll();

      expect(all).toHaveLength(3);
      expect(all.map((p) => p.id)).toEqual(["claude", "openai", "opencode-go"]);
    });

    it("getEnabled returns all when no providers are disabled", () => {
      const registry = createRegistry([
        createClaudeProvider(),
        createOpenAIProvider(),
        createOpenCodeGoProvider(),
      ]);

      expect(registry.getEnabled()).toHaveLength(3);
      expect(registry.getEnabled([])).toHaveLength(3);
    });
  });

  describe("cache isolation between providers", () => {
    it("two refresh loops write to isolated namespaces without cross-contamination", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const deps = makeFakeDeps();
      const claudeWindows = makeWindows(30);
      const openaiWindows = makeWindows(50, 70);

      const claudeTracker = createStateTracker();
      const openaiTracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "claude",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: "claude@test.com",
            windows: claudeWindows,
            profile: { email: "claude@test.com" },
            extras: { credits: 100 },
          }),
        ),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: claudeTracker.setState,
      });

      createRefreshLoop({
        provider: makeFakeProvider(
          "openai",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: "openai@test.com",
            windows: openaiWindows,
            profile: { email: "openai@test.com" },
            extras: null,
          }),
        ),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: openaiTracker.setState,
      });

      await claudeTracker.waitFor(1);
      await openaiTracker.waitFor(1);
      ac.abort();

      expect(cache.read("claude", "claude@test.com")!.windows).toEqual(claudeWindows);
      expect(cache.read("claude", "claude@test.com")!.extras).toEqual({ credits: 100 });
      expect(cache.read("openai", "openai@test.com")!.windows).toEqual(openaiWindows);
      expect(cache.read("claude", "openai@test.com")).toBeNull();
      expect(cache.read("openai", "claude@test.com")).toBeNull();
    });
  });

  describe("blacklist filtering", () => {
    it("disabledProviders excludes openai from enabled list", () => {
      const registry = createRegistry([createClaudeProvider(), createOpenAIProvider()]);
      const enabled = registry.getEnabled(["openai"]);

      expect(enabled).toHaveLength(1);
      expect(enabled[0].id).toBe("claude");
    });

    it("only enabled providers run refresh loops end-to-end", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const deps = makeFakeDeps();

      const claudeFetch = vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
        accountKey: null,
        windows: makeWindows(40),
        profile: null,
        extras: null,
      });
      const openaiFetch = vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
        accountKey: null,
        windows: makeWindows(60),
        profile: null,
        extras: null,
      });

      const providers = [
        makeFakeProvider("claude", claudeFetch),
        makeFakeProvider("openai", openaiFetch),
      ];
      const registry = createRegistry(providers);
      const enabled = registry.getEnabled(["openai"]);
      const ac = new AbortController();
      const tracker = createStateTracker();

      for (const p of enabled) {
        createRefreshLoop({
          provider: p,
          deps,
          cache,
          signal: ac.signal,
          intervalMs: 60_000,
          setState: tracker.setState,
        });
      }

      await tracker.waitFor(1);
      ac.abort();

      expect(claudeFetch).toHaveBeenCalledTimes(1);
      expect(openaiFetch).not.toHaveBeenCalled();
      expect(cache.read("claude", UNKNOWN_ACCOUNT_KEY)).not.toBeNull();
      expect(cache.read("openai", UNKNOWN_ACCOUNT_KEY)).toBeNull();
    });
  });

  describe("inverted mode across providers", () => {
    it("computeDisplayPercent returns remaining percentage for both providers", () => {
      const claudePercent = toPercent(30);
      const openaiPercent = toPercent(70);

      expect(computeDisplayPercent(claudePercent, true)).toBe(toPercent(70));
      expect(computeDisplayPercent(openaiPercent, true)).toBe(toPercent(30));
      expect(computeDisplayPercent(claudePercent, false)).toBe(claudePercent);
    });

    it("getPercentColor applies consistent thresholds in both modes", () => {
      const defaultColor = "#FFFFFF";

      expect(getPercentColor(toPercent(15), defaultColor, true)).toBe("#D32F2F");
      expect(getPercentColor(toPercent(35), defaultColor, true)).toBe("#F0A875");
      expect(getPercentColor(toPercent(60), defaultColor, true)).toBe(defaultColor);

      expect(getPercentColor(toPercent(85), defaultColor, false)).toBe("#E07A3A");
      expect(getPercentColor(toPercent(55), defaultColor, false)).toBe("#F0A875");
      expect(getPercentColor(toPercent(30), defaultColor, false)).toBe(defaultColor);
    });

    it("inverted display percent and color are identical for same-percent windows across providers", () => {
      const claudeWindow: UsageWindow = {
        label: "Session",
        percent: toPercent(80),
        resetsAt: toUnixMs(FROZEN_NOW + 3_600_000),
        isActive: true,
      };
      const openaiWindow: UsageWindow = {
        label: "Daily",
        percent: toPercent(80),
        resetsAt: toUnixMs(FROZEN_NOW + 86_400_000),
        isActive: true,
      };

      const claudeRemaining = computeDisplayPercent(claudeWindow.percent, true);
      const openaiRemaining = computeDisplayPercent(openaiWindow.percent, true);

      expect(claudeRemaining).toBe(openaiRemaining);
      expect(getPercentColor(claudeRemaining, "#AAA", true)).toBe(
        getPercentColor(openaiRemaining, "#AAA", true),
      );
    });
  });

  describe("error handling per provider", () => {
    it("failing provider preserves stale cache while succeeding provider updates independently", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const deps = makeFakeDeps();
      const staleWindows = makeWindows(25);

      await cache.write("claude", UNKNOWN_ACCOUNT_KEY, {
        timestamp: FROZEN_NOW - 30_000,
        windows: staleWindows,
        profile: { email: "stale@test.com" },
        extras: null,
      });

      const freshWindows = makeWindows(60);
      const claudeTracker = createStateTracker();
      const openaiTracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "claude",
          vi.fn<ProviderDefinition["fetch"]>().mockRejectedValue(new Error("network down")),
        ),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: claudeTracker.setState,
      });

      createRefreshLoop({
        provider: makeFakeProvider(
          "openai",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: "openai@test.com",
            windows: freshWindows,
            profile: { email: "openai@test.com" },
            extras: null,
          }),
        ),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: openaiTracker.setState,
      });

      const claudeErrorState = await claudeTracker.waitFor(2);
      const openaiState = await openaiTracker.waitFor(1);
      ac.abort();

      expect(claudeErrorState.error).toBe("network down");
      expect(claudeErrorState.windows).toEqual(staleWindows);
      expect(openaiState.error).toBeNull();
      expect(openaiState.windows).toEqual(freshWindows);
    });
  });

  describe("window resilience", () => {
    it("provider returning zero windows stores empty array in cache", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "test",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: null,
            windows: [],
            profile: null,
            extras: null,
          }),
        ),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const state = await tracker.waitFor(1);
      ac.abort();

      expect(state.windows).toEqual([]);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toEqual([]);
    });

    it("provider returning one window stores exactly one", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const singleWindow = makeWindows(50);
      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "test",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: null,
            windows: singleWindow,
            profile: null,
            extras: null,
          }),
        ),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const state = await tracker.waitFor(1);
      ac.abort();

      expect(state.windows).toHaveLength(1);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toHaveLength(1);
    });

    it("provider returning N windows stores all N", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const nWindows = makeWindows(10, 30, 50, 80);
      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "test",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: null,
            windows: nWindows,
            profile: null,
            extras: null,
          }),
        ),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const state = await tracker.waitFor(1);
      ac.abort();

      expect(state.windows).toHaveLength(4);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toHaveLength(4);
    });

    it("two windows shrink to one on next successful fetch — cache replaces, not merges", async () => {
      vi.useFakeTimers({ now: FROZEN_NOW });

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const twoWindows = makeWindows(30, 60);
      const oneWindow = makeWindows(45);
      let fetchCount = 0;

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          accountKey: null,
          windows: fetchCount === 1 ? twoWindows : oneWindow,
          profile: null,
          extras: null,
        });
      });

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("test", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 5_000,
        setState: tracker.setState,
      });

      await tracker.waitFor(1);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toHaveLength(2);

      await vi.advanceTimersByTimeAsync(5_000);
      await tracker.waitFor(2);

      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toHaveLength(1);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)!.windows).toEqual(oneWindow);

      ac.abort();
    });
  });

  describe("dispose", () => {
    it("abort signal stops both loops and pending settles within 5000ms", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const deps = makeFakeDeps();

      const fetchA = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(
        (_d, signal) =>
          new Promise<FetchResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );
      const fetchB = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(
        (_d, signal) =>
          new Promise<FetchResult>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      );

      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("a", fetchA),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: vi.fn(),
      });
      createRefreshLoop({
        provider: makeFakeProvider("b", fetchB),
        deps,
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: vi.fn(),
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);

      const start = performance.now();
      ac.abort();
      await new Promise((r) => setTimeout(r, 50));
      const elapsed = performance.now() - start;

      expect(elapsed).toBeLessThan(5_000);
      expect(fetchA).toHaveBeenCalledTimes(1);
      expect(fetchB).toHaveBeenCalledTimes(1);
    });

    it("child.kill is invoked on abort for openai-style provider with spawned child", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const killFn = vi.fn();

      const provider = makeFakeProvider(
        "openai-child",
        vi.fn<ProviderDefinition["fetch"]>().mockImplementation(
          (_d, signal) =>
            new Promise<FetchResult>((_resolve, reject) => {
              signal.addEventListener(
                "abort",
                () => {
                  killFn();
                  reject(new Error("child killed"));
                },
                { once: true },
              );
            }),
        ),
      );

      const ac = new AbortController();

      createRefreshLoop({
        provider,
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: vi.fn(),
      });

      await new Promise((r) => setTimeout(r, 20));
      expect(provider.fetch as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);

      ac.abort();
      await new Promise((r) => setTimeout(r, 20));

      expect(killFn).toHaveBeenCalledTimes(1);
    });
  });

  describe("failure paths", () => {
    it("codex absent makes openai detect return available:false with reason", async () => {
      const openai = createOpenAIProvider();
      const deps = makeFakeDeps({
        exec: vi.fn().mockImplementation(() => {
          throw new Error("not found");
        }),
      });

      const result = await openai.detect(deps, new AbortController().signal);

      expect(result.available).toBe(false);
      expect((result as { available: false; reason: string }).reason).toEqual(expect.any(String));
    });

    it("429 with Retry-After delays next fetch by at least retryAfterS", async () => {
      vi.useFakeTimers({ now: FROZEN_NOW });

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const retryAfterS = 5;
      let fetchCount = 0;

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          return Promise.reject(
            new ProviderFetchError("rate limited", {
              kind: "http",
              status: 429,
              retryAfterS,
            }),
          );
        }
        return Promise.resolve({
          accountKey: null,
          windows: makeWindows(50),
          profile: null,
          extras: null,
        });
      });

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("test", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(fetchCount).toBe(1);

      await vi.advanceTimersByTimeAsync(retryAfterS * 1000 - 1);
      expect(fetchCount).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      await tracker.waitFor(1);

      expect(fetchCount).toBe(2);
      expect(tracker.calls[0].error).toBeNull();
      expect(tracker.calls[0].windows).toEqual(makeWindows(50));

      ac.abort();
    });

    it("malformed cache.json is treated as empty and first fetch writes fresh data", async () => {
      await writeFile(join(tmpDir, "cache.json"), "<<<not json>>>");

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const freshWindows = makeWindows(42);
      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "test",
          vi.fn<ProviderDefinition["fetch"]>().mockResolvedValue({
            accountKey: null,
            windows: freshWindows,
            profile: null,
            extras: null,
          }),
        ),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const state = await tracker.waitFor(1);
      ac.abort();

      expect(state.error).toBeNull();
      expect(state.windows).toEqual(freshWindows);

      const raw = await readFile(join(tmpDir, "cache.json"), "utf8");
      const schema = JSON.parse(raw);
      expect(schema.version).toBe(1);
      expect(schema.providers.test.accounts[UNKNOWN_ACCOUNT_KEY].windows).toEqual(freshWindows);
    });
  });

  describe("error-path state preservation after account-key migration", () => {
    it("success→migrate→fail preserves windows+profile with error set and lastFetchedAt preserved", async () => {
      vi.useFakeTimers({ now: FROZEN_NOW });

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      let fetchCount = 0;

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 1) {
          return Promise.resolve({
            accountKey: "user@x.com",
            windows: makeWindows(30),
            profile: { email: "user@x.com" },
            extras: { credits: 100 },
          });
        }
        return Promise.reject(new Error("server error"));
      });

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("claude", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 5_000,
        setState: tracker.setState,
      });

      await tracker.waitFor(1);
      expect(tracker.calls[0].error).toBeNull();
      expect(tracker.calls[0].windows).toEqual(makeWindows(30));
      expect(tracker.calls[0].lastFetchedAt).toBe(FROZEN_NOW);

      expect(cache.read("claude", UNKNOWN_ACCOUNT_KEY)).toBeNull();
      expect(cache.read("claude", "user@x.com")).not.toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      await tracker.waitFor(2);

      const errorState = tracker.calls[1];
      expect(errorState.error).toBe("server error");
      expect(errorState.windows).toEqual(makeWindows(30));
      expect(errorState.profile).toEqual({ email: "user@x.com" });
      expect(errorState.extras).toEqual({ credits: 100 });
      expect(errorState.lastFetchedAt).toBe(FROZEN_NOW);

      ac.abort();
    });

    it("cold-start fail with no prior data yields error state with empty windows", async () => {
      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider(
          "claude",
          vi.fn<ProviderDefinition["fetch"]>().mockRejectedValue(new Error("auth failed")),
        ),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const state = await tracker.waitFor(1);
      ac.abort();

      expect(state.error).toBe("auth failed");
      expect(state.windows).toEqual([]);
      expect(state.profile).toBeNull();
      expect(state.lastFetchedAt).toBeNull();
    });

    it("success→fail→success sequence never emits empty-windows state after first success", async () => {
      vi.useFakeTimers({ now: FROZEN_NOW });

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      let fetchCount = 0;

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(() => {
        fetchCount++;
        if (fetchCount === 2) {
          return Promise.reject(new Error("transient"));
        }
        return Promise.resolve({
          accountKey: "user@x.com",
          windows: makeWindows(fetchCount * 10),
          profile: { email: "user@x.com" },
          extras: null,
        });
      });

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("claude", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 5_000,
        setState: tracker.setState,
      });

      await tracker.waitFor(1);
      await vi.advanceTimersByTimeAsync(5_000);
      await tracker.waitFor(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await tracker.waitFor(3);
      ac.abort();

      for (let i = 0; i < tracker.calls.length; i++) {
        const state = tracker.calls[i];
        if (i >= 1) {
          expect(state.windows.length).toBeGreaterThan(0);
          expect(state.lastFetchedAt).not.toBeNull();
        }
      }

      expect(tracker.calls[0].error).toBeNull();
      expect(tracker.calls[1].error).toBe("transient");
      expect(tracker.calls[1].windows).toEqual(makeWindows(10));
      expect(tracker.calls[2].error).toBeNull();
      expect(tracker.calls[2].windows).toEqual(makeWindows(30));
    });
  });

  describe("__unknown__ to accountKey migration through refresh loop", () => {
    it("first fetch with null accountKey caches under __unknown__ then second fetch migrates to real key", async () => {
      vi.useFakeTimers({ now: FROZEN_NOW });

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      let fetchCount = 0;

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(() => {
        fetchCount++;
        return Promise.resolve({
          accountKey: fetchCount === 1 ? null : "user@x.com",
          windows: makeWindows(fetchCount * 20),
          profile: fetchCount === 1 ? null : { email: "user@x.com" },
          extras: null,
        });
      });

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("test", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 5_000,
        setState: tracker.setState,
      });

      await tracker.waitFor(1);
      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)).not.toBeNull();
      expect(cache.read("test", "user@x.com")).toBeNull();

      await vi.advanceTimersByTimeAsync(5_000);
      await tracker.waitFor(2);

      expect(cache.read("test", UNKNOWN_ACCOUNT_KEY)).toBeNull();
      expect(cache.read("test", "user@x.com")).not.toBeNull();
      expect(cache.read("test", "user@x.com")!.windows).toEqual(makeWindows(40));

      const raw = await readFile(join(tmpDir, "cache.json"), "utf8");
      const schema = JSON.parse(raw);
      expect(schema.providers.test.accounts[UNKNOWN_ACCOUNT_KEY]).toBeUndefined();
      expect(schema.providers.test.accounts["user@x.com"]).toBeDefined();

      ac.abort();
    });
  });

  describe("cold-start seeding from email key (no __unknown__)", () => {
    it("seed emits setState with cached data before any fetch runs when cache has email key only", async () => {
      const cachedWindows = makeWindows(25, 60);
      const cachedProfile = { email: "juneyoung.kang@wantedlab.com" };

      const cache = createCacheStore({ cacheDir: tmpDir, now: () => FROZEN_NOW });
      await cache.write("claude", "juneyoung.kang@wantedlab.com", {
        timestamp: FROZEN_NOW - 15_000,
        windows: cachedWindows,
        profile: cachedProfile,
        extras: { credits: 50 },
      });

      expect(cache.read("claude", UNKNOWN_ACCOUNT_KEY)).toBeNull();

      const fetchFn = vi.fn<ProviderDefinition["fetch"]>().mockImplementation(
        () =>
          new Promise<FetchResult>(() => {
            // never resolves — ensures seed fires before fetch
          }),
      );

      const tracker = createStateTracker();
      const ac = new AbortController();

      createRefreshLoop({
        provider: makeFakeProvider("claude", fetchFn),
        deps: makeFakeDeps(),
        cache,
        signal: ac.signal,
        intervalMs: 60_000,
        setState: tracker.setState,
      });

      const seeded = await tracker.waitFor(1);
      ac.abort();

      expect(seeded.error).toBeNull();
      expect(seeded.windows).toEqual(cachedWindows);
      expect(seeded.profile).toEqual(cachedProfile);
      expect(seeded.extras).toEqual({ credits: 50 });
      expect(seeded.lastFetchedAt).toBe(FROZEN_NOW - 15_000);
    });
  });
});

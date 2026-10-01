import type {
  AccountCache,
  CacheStore,
  FetchResult,
  ProviderDefinition,
  ProviderDeps,
  RefreshDataSource,
  RefreshDiagnostics,
  RefreshPhase,
  RefreshState,
} from "./types";
import { ProviderFetchError, UNKNOWN_ACCOUNT_KEY } from "./types";
import { type DebugLog, noopDebugLog } from "./debug-log";

export interface RefreshLoopOptions {
  provider: ProviderDefinition<unknown>;
  deps: ProviderDeps;
  cache: CacheStore;
  signal: AbortSignal;
  intervalMs: number;
  setState: (state: RefreshState) => void;
  log?: DebugLog;
}

export interface RefreshLoopHandle {
  diagnostics: () => RefreshDiagnostics;
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const NETWORK_RETRY_DELAYS = [500];
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_JITTER_MS = 10_000;
const JITTER_RATIO = 0.1;
const FETCH_LOCK_TTL_MS = 60_000;
const LOCK_BUSY_RECHECK_MS = 5_000;
const MINUTE_MS = 60_000;
const MAX_FAILURE_BACKOFF_MS = 15 * MINUTE_MS;
const RATE_LIMIT_PROBE_CAP_MS = 15 * MINUTE_MS;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * MINUTE_MS;

function rateLimitRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof ProviderFetchError)) return null;
  if (error.info.kind !== "http" || error.info.status !== 429) return null;
  return (error.info.retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000;
}

/**
 * Delay before any process may fetch again after the `streak`-th consecutive failure.
 * A 429's Retry-After is clamped to a probe cap (15m, 30m, then 60m) because the
 * endpoint often lifts much sooner than it advertises; a single lock holder probes it.
 */
export function failureBackoffMs(error: unknown, streak: number, intervalMs: number): number {
  const retryAfterMs = rateLimitRetryAfterMs(error);
  if (retryAfterMs === null) {
    return Math.min(intervalMs * 2 ** (streak - 1), MAX_FAILURE_BACKOFF_MS);
  }
  const probeCapMs = Math.min(
    RATE_LIMIT_PROBE_CAP_MS * 2 ** (streak - 1),
    MAX_RATE_LIMIT_BACKOFF_MS,
  );
  return Math.min(Math.max(retryAfterMs, intervalMs * 2 ** streak), probeCapMs);
}

interface RetryHooks {
  setPhase: (phase: RefreshPhase) => void;
  log: DebugLog;
}

async function fetchWithRetry(
  provider: ProviderDefinition<unknown>,
  deps: ProviderDeps,
  signal: AbortSignal,
  hooks: RetryHooks,
): Promise<FetchResult<unknown>> {
  for (let attempt = 0; attempt <= NETWORK_RETRY_DELAYS.length; attempt++) {
    try {
      hooks.setPhase("fetching");
      return await provider.fetch(deps, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof ProviderFetchError)) throw error;

      const isRetryable =
        error.info.kind === "network" || (error.info.kind === "http" && error.info.status >= 500);

      if (!isRetryable || attempt >= NETWORK_RETRY_DELAYS.length) {
        throw error;
      }

      hooks.log("fetch.retry", {
        provider: provider.id,
        attempt,
        delayMs: NETWORK_RETRY_DELAYS[attempt],
        error: error.message,
        info: error.info,
      });
      hooks.setPhase("retry-wait");
      await delay(NETWORK_RETRY_DELAYS[attempt], signal);
    }
  }

  throw new Error("Unreachable: fetch retry loop exited without result");
}

/**
 * Runs the fetch loop for one provider. Several OpenCode processes share the cache, so
 * every cycle first shows any newer data another process wrote, skips fetching while
 * the cached data is younger than the interval, honors the shared failure backoff, and
 * only fetches while holding the provider's cross-process fetch lock. While waiting on
 * a backoff or a busy lock it keeps checking the cache every interval, so a peer's
 * successful fetch shows up without waiting out the backoff.
 */
export function createRefreshLoop(options: RefreshLoopOptions): RefreshLoopHandle {
  const { provider, deps, cache, signal, intervalMs, setState } = options;
  const log = options.log ?? noopDebugLog;

  let lastKnownAccountKey: string = UNKNOWN_ACCOUNT_KEY;
  let lastGoodState: RefreshState | null = null;

  const diag: RefreshDiagnostics = {
    phase: "fetching",
    phaseSince: deps.now(),
    nextCycleAt: null,
    cycles: 0,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastError: null,
    consecutiveFailures: 0,
    dataSource: "none",
    dataWriterPid: null,
  };

  const setPhase = (phase: RefreshPhase) => {
    diag.phase = phase;
    diag.phaseSince = deps.now();
  };

  const jitterMs = () => Math.random() * Math.min(MAX_JITTER_MS, intervalMs * JITTER_RATIO);

  const adopt = (accountKey: string, entry: AccountCache, source: RefreshDataSource) => {
    lastKnownAccountKey = accountKey;
    const state: RefreshState = {
      windows: entry.windows,
      profile: entry.profile,
      extras: entry.extras,
      error: null,
      lastFetchedAt: entry.timestamp,
    };
    lastGoodState = state;
    diag.dataSource = source;
    diag.dataWriterPid = entry.writerPid ?? null;
    setState(state);
  };

  const adoptNewerCacheEntry = (): number | null => {
    const latest = cache.readLatest(provider.id);
    if (!latest) return null;
    if (latest.entry.timestamp > (lastGoodState?.lastFetchedAt ?? -Infinity)) {
      diag.lastError = null;
      diag.consecutiveFailures = 0;
      adopt(latest.accountKey, latest.entry, "cache-peer");
      log("cycle.peer", {
        provider: provider.id,
        cycle: diag.cycles,
        accountKey: latest.accountKey,
        lastFetchedAt: latest.entry.timestamp,
        writerPid: latest.entry.writerPid ?? null,
      });
    }
    return deps.now() - latest.entry.timestamp;
  };

  const scheduleIn = (ms: number, phase: RefreshPhase = "scheduled") => {
    if (signal.aborted) return;
    const waitMs = Math.max(0, ms) + jitterMs();
    setPhase(phase);
    diag.nextCycleAt = deps.now() + waitMs;
    const timer = setTimeout(runCycle, waitMs);
    const onAbort = () => clearTimeout(timer);
    signal.addEventListener("abort", onAbort, { once: true });
  };

  const cycle = async () => {
    if (signal.aborted) return;

    diag.cycles += 1;
    diag.nextCycleAt = null;
    const startedAt = deps.now();
    log("cycle.start", { provider: provider.id, cycle: diag.cycles });

    const cachedAgeMs = adoptNewerCacheEntry();
    if (cachedAgeMs !== null && cachedAgeMs < intervalMs) {
      log("cycle.fresh", { provider: provider.id, cycle: diag.cycles, cachedAgeMs });
      scheduleIn(intervalMs - cachedAgeMs);
      return;
    }

    const backoff = cache.getBackoff(provider.id);
    if (backoff.nextAttemptAt !== null) {
      log("cycle.backoff", {
        provider: provider.id,
        cycle: diag.cycles,
        nextAttemptAt: backoff.nextAttemptAt,
        failureStreak: backoff.failureStreak,
        waitMs: backoff.nextAttemptAt - startedAt,
      });
      scheduleIn(Math.min(intervalMs, backoff.nextAttemptAt - startedAt), "backoff-wait");
      return;
    }

    const releaseLock = cache.tryAcquireFetchLock(provider.id, FETCH_LOCK_TTL_MS);
    if (releaseLock === null) {
      log("cycle.lock_busy", { provider: provider.id, cycle: diag.cycles });
      scheduleIn(Math.min(intervalMs, LOCK_BUSY_RECHECK_MS), "lock-wait");
      return;
    }

    try {
      const result = await fetchWithRetry(provider, deps, signal, { setPhase, log });
      if (signal.aborted) return;

      const accountKey = result.accountKey ?? UNKNOWN_ACCOUNT_KEY;
      lastKnownAccountKey = accountKey;

      if (result.accountKey !== null) {
        await cache.migrateUnknown(provider.id, accountKey);
      }

      const entry: AccountCache = {
        timestamp: deps.now(),
        windows: result.windows,
        profile: result.profile,
        extras: result.extras,
        writerPid: process.pid,
      };

      await cache.write(provider.id, accountKey, entry);
      if (backoff.failureStreak > 0) await cache.setBackoff(provider.id, null);

      const good: RefreshState = {
        windows: result.windows,
        profile: result.profile,
        extras: result.extras,
        error: null,
        lastFetchedAt: entry.timestamp,
      };
      lastGoodState = good;
      diag.lastSuccessAt = entry.timestamp;
      diag.lastError = null;
      diag.consecutiveFailures = 0;
      diag.dataSource = "fetch";
      diag.dataWriterPid = process.pid;
      log("cycle.success", {
        provider: provider.id,
        cycle: diag.cycles,
        durationMs: deps.now() - startedAt,
        accountKey,
        lastFetchedAt: entry.timestamp,
        clearedFailureStreak: backoff.failureStreak,
      });
      setState(good);
    } catch (error) {
      if (signal.aborted) return;

      const failureStreak = backoff.failureStreak + 1;
      const backoffMs = failureBackoffMs(error, failureStreak, intervalMs);
      const nextAttemptAt = deps.now() + backoffMs;
      await cache.setBackoff(provider.id, { nextAttemptAt, failureStreak });
      log("fetch.backoff", {
        provider: provider.id,
        cycle: diag.cycles,
        failureStreak,
        backoffMs,
        nextAttemptAt,
        retryAfterS:
          error instanceof ProviderFetchError && error.info.kind === "http"
            ? (error.info.retryAfterS ?? null)
            : null,
      });

      const previousFetchedAt = lastGoodState?.lastFetchedAt ?? null;
      adoptNewerCacheEntry();
      if ((lastGoodState?.lastFetchedAt ?? null) !== previousFetchedAt) {
        scheduleIn(intervalMs);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const info = error instanceof ProviderFetchError ? error.info : null;
      diag.lastError = errorMessage;
      diag.lastErrorAt = deps.now();
      diag.consecutiveFailures += 1;

      const failureFields = {
        provider: provider.id,
        cycle: diag.cycles,
        durationMs: deps.now() - startedAt,
        error: errorMessage,
        info,
        consecutiveFailures: diag.consecutiveFailures,
      };

      if (lastGoodState) {
        log("cycle.failure", {
          ...failureFields,
          keptLastFetchedAt: lastGoodState.lastFetchedAt,
          dataSource: diag.dataSource,
          dataWriterPid: diag.dataWriterPid,
        });
        setState({
          windows: lastGoodState.windows,
          profile: lastGoodState.profile,
          extras: lastGoodState.extras,
          error: errorMessage,
          lastFetchedAt: lastGoodState.lastFetchedAt,
        });
      } else {
        const stale =
          cache.read(provider.id, lastKnownAccountKey) ??
          (lastKnownAccountKey !== UNKNOWN_ACCOUNT_KEY
            ? cache.read(provider.id, UNKNOWN_ACCOUNT_KEY)
            : null);

        if (stale) {
          diag.dataSource = "cache-fallback";
          diag.dataWriterPid = stale.writerPid ?? null;
        }
        log("cycle.failure", {
          ...failureFields,
          keptLastFetchedAt: stale?.timestamp ?? null,
          dataSource: diag.dataSource,
          dataWriterPid: diag.dataWriterPid,
        });

        setState({
          windows: stale?.windows ?? [],
          profile: stale?.profile ?? null,
          extras: stale?.extras ?? null,
          error: errorMessage,
          lastFetchedAt: stale?.timestamp ?? null,
        });
      }
    } finally {
      releaseLock();
    }

    scheduleIn(intervalMs);
  };

  const runCycle = () => {
    cycle().catch((error: unknown) => {
      log("cycle.crash", {
        provider: provider.id,
        cycle: diag.cycles,
        error: error instanceof Error ? error.message : String(error),
      });
      scheduleIn(intervalMs);
    });
  };

  const seed = cache.readLatest(provider.id);
  if (seed) {
    const seedAgeMs = deps.now() - seed.entry.timestamp;
    const deferFetchMs = seedAgeMs < intervalMs ? intervalMs - seedAgeMs : 0;
    log("cache.seed", {
      provider: provider.id,
      accountKey: seed.accountKey,
      entryTimestamp: seed.entry.timestamp,
      ageMs: seedAgeMs,
      writerPid: seed.entry.writerPid ?? null,
      deferFetchMs,
    });
    adopt(seed.accountKey, seed.entry, "cache-seed");
    if (deferFetchMs > 0) {
      scheduleIn(deferFetchMs);
      return { diagnostics: () => ({ ...diag }) };
    }
  } else {
    log("cache.seed_miss", { provider: provider.id });
  }

  runCycle();

  return { diagnostics: () => ({ ...diag }) };
}

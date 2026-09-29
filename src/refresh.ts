import type {
  AccountCache,
  CacheStore,
  FetchResult,
  ProviderDefinition,
  ProviderDeps,
  RefreshState,
} from "./types";
import { ProviderFetchError, UNKNOWN_ACCOUNT_KEY } from "./types";

export interface RefreshLoopOptions {
  provider: ProviderDefinition<unknown>;
  deps: ProviderDeps;
  cache: CacheStore;
  signal: AbortSignal;
  intervalMs: number;
  setState: (state: RefreshState) => void;
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

const BACKOFF_DELAYS = [200, 400, 800];
const DEFAULT_RETRY_AFTER_S = 60;
const MAX_JITTER_MS = 10_000;
const JITTER_RATIO = 0.1;
const MAX_RATE_LIMIT_BACKOFF_MS = 10 * 60 * 1000;

function rateLimitRetryAfterMs(error: unknown): number | null {
  if (!(error instanceof ProviderFetchError)) return null;
  if (error.info.kind !== "http" || error.info.status !== 429) return null;
  return (error.info.retryAfterS ?? DEFAULT_RETRY_AFTER_S) * 1000;
}

async function fetchWithRetry(
  provider: ProviderDefinition<unknown>,
  deps: ProviderDeps,
  signal: AbortSignal,
): Promise<FetchResult<unknown>> {
  for (let attempt = 0; attempt <= BACKOFF_DELAYS.length; attempt++) {
    try {
      return await provider.fetch(deps, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (!(error instanceof ProviderFetchError)) throw error;

      const isRetryable =
        error.info.kind === "network" || (error.info.kind === "http" && error.info.status >= 500);

      if (!isRetryable || attempt >= BACKOFF_DELAYS.length) {
        throw error;
      }

      await delay(BACKOFF_DELAYS[attempt], signal);
    }
  }

  throw new Error("Unreachable: fetch retry loop exited without result");
}

/**
 * Runs the fetch loop for one provider. Several OpenCode processes share the cache, so
 * each cycle first adopts fresher data written by another process and honors a
 * cache-wide 429 cooldown before fetching; only one process per interval should hit
 * the provider API.
 */
export function createRefreshLoop(options: RefreshLoopOptions): void {
  const { provider, deps, cache, signal, intervalMs, setState } = options;

  let lastKnownAccountKey: string = UNKNOWN_ACCOUNT_KEY;
  let lastGoodState: RefreshState | null = null;
  let rateLimitStreak = 0;

  const jitterMs = () => Math.random() * Math.min(MAX_JITTER_MS, intervalMs * JITTER_RATIO);

  const adopt = (accountKey: string, entry: AccountCache) => {
    lastKnownAccountKey = accountKey;
    const state: RefreshState = {
      windows: entry.windows,
      profile: entry.profile,
      extras: entry.extras,
      error: null,
      lastFetchedAt: entry.timestamp,
    };
    lastGoodState = state;
    setState(state);
  };

  const readFreshPeer = () => {
    const latest = cache.readLatest(provider.id);
    if (!latest) return null;
    const isNewer = latest.entry.timestamp > (lastGoodState?.lastFetchedAt ?? -Infinity);
    const isFresh = deps.now() - latest.entry.timestamp < intervalMs;
    return isNewer && isFresh ? latest : null;
  };

  const scheduleIn = (ms: number) => {
    if (signal.aborted) return;
    const timer = setTimeout(
      () => {
        void cycle();
      },
      Math.max(0, ms) + jitterMs(),
    );
    const onAbort = () => clearTimeout(timer);
    signal.addEventListener("abort", onAbort, { once: true });
  };

  const cycle = async () => {
    if (signal.aborted) return;

    const peer = readFreshPeer();
    if (peer) {
      adopt(peer.accountKey, peer.entry);
      scheduleIn(intervalMs);
      return;
    }

    const cooldownUntil = cache.getRateLimitedUntil(provider.id);
    if (cooldownUntil !== null) {
      scheduleIn(cooldownUntil - deps.now());
      return;
    }

    let nextDelayMs = intervalMs;

    try {
      const result = await fetchWithRetry(provider, deps, signal);
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
      };

      await cache.write(provider.id, accountKey, entry);
      rateLimitStreak = 0;

      const good: RefreshState = {
        windows: result.windows,
        profile: result.profile,
        extras: result.extras,
        error: null,
        lastFetchedAt: entry.timestamp,
      };
      lastGoodState = good;
      setState(good);
    } catch (error) {
      if (signal.aborted) return;

      const retryAfterMs = rateLimitRetryAfterMs(error);
      if (retryAfterMs !== null) {
        rateLimitStreak += 1;
        await cache.setRateLimitedUntil(provider.id, deps.now() + retryAfterMs);
        const backoffMs = Math.min(intervalMs * 2 ** rateLimitStreak, MAX_RATE_LIMIT_BACKOFF_MS);
        nextDelayMs = Math.max(retryAfterMs, backoffMs);
      }

      const peerAfterFailure = readFreshPeer();
      if (peerAfterFailure) {
        adopt(peerAfterFailure.accountKey, peerAfterFailure.entry);
        scheduleIn(nextDelayMs);
        return;
      }

      const errorMessage = error instanceof Error ? error.message : String(error);

      if (lastGoodState) {
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

        setState({
          windows: stale?.windows ?? [],
          profile: stale?.profile ?? null,
          extras: stale?.extras ?? null,
          error: errorMessage,
          lastFetchedAt: stale?.timestamp ?? null,
        });
      }
    }

    scheduleIn(nextDelayMs);
  };

  const seed = cache.readLatest(provider.id);
  if (seed) {
    adopt(seed.accountKey, seed.entry);
    const seedAgeMs = deps.now() - seed.entry.timestamp;
    if (seedAgeMs < intervalMs) {
      scheduleIn(intervalMs - seedAgeMs);
      return;
    }
  }

  void cycle();
}

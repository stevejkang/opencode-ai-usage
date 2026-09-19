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

      if (error.info.kind === "http" && error.info.status === 429) {
        const waitS = error.info.retryAfterS ?? DEFAULT_RETRY_AFTER_S;
        await delay(waitS * 1000, signal);
        return await provider.fetch(deps, signal);
      }

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

export function createRefreshLoop(options: RefreshLoopOptions): void {
  const { provider, deps, cache, signal, intervalMs, setState } = options;

  let lastKnownAccountKey: string = UNKNOWN_ACCOUNT_KEY;
  let lastGoodState: RefreshState | null = null;

  const seed = cache.readLatest(provider.id);
  if (seed) {
    lastKnownAccountKey = seed.accountKey;
    const seeded: RefreshState = {
      windows: seed.entry.windows,
      profile: seed.entry.profile,
      extras: seed.entry.extras,
      error: null,
      lastFetchedAt: seed.entry.timestamp,
    };
    lastGoodState = seeded;
    setState(seeded);
  }

  const scheduleNext = () => {
    if (signal.aborted) return;
    const timer = setTimeout(() => {
      void cycle();
    }, intervalMs);
    const onAbort = () => clearTimeout(timer);
    signal.addEventListener("abort", onAbort, { once: true });
  };

  const cycle = async () => {
    if (signal.aborted) return;

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

    scheduleNext();
  };

  void cycle();
}

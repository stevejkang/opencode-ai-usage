import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCache, CacheSchema, CacheStore, FetchBackoff } from "./types";
import { UNKNOWN_ACCOUNT_KEY } from "./types";

const STALENESS_CEILING_MS = 60 * 60 * 1000;
const DEFAULT_CACHE_DIR = join(homedir(), ".cache", "opencode-ai-usage");
const CACHE_FILENAME = "cache.json";

export interface CacheStoreDeps {
  cacheDir?: string;
  now?: () => number;
}

function emptyCacheSchema(): CacheSchema {
  return { version: 1, providers: {} };
}

function parseCacheJson(raw: string): CacheSchema {
  try {
    const data = JSON.parse(raw);
    if (
      data !== null &&
      typeof data === "object" &&
      data.version === 1 &&
      typeof data.providers === "object" &&
      data.providers !== null
    ) {
      return data as CacheSchema;
    }
    return emptyCacheSchema();
  } catch {
    return emptyCacheSchema();
  }
}

function readSchemaSync(path: string): CacheSchema {
  try {
    return parseCacheJson(readFileSync(path, "utf8"));
  } catch {
    return emptyCacheSchema();
  }
}

async function readSchemaAsync(path: string): Promise<CacheSchema> {
  try {
    return parseCacheJson(await readFile(path, "utf8"));
  } catch {
    return emptyCacheSchema();
  }
}

function pruneExpired(schema: CacheSchema, currentTime: number): void {
  for (const pid of Object.keys(schema.providers)) {
    const provider = schema.providers[pid];
    for (const key of Object.keys(provider.accounts)) {
      if (currentTime - provider.accounts[key].timestamp > STALENESS_CEILING_MS) {
        delete provider.accounts[key];
      }
    }
    const coolingDown = (provider.nextAttemptAt ?? 0) > currentTime;
    if (Object.keys(provider.accounts).length === 0 && !coolingDown) {
      delete schema.providers[pid];
    }
  }
}

/** Creates a CacheStore backed by a single JSON file with serialized writes. */
export function createCacheStore(deps: CacheStoreDeps = {}): CacheStore {
  const cacheDir = deps.cacheDir ?? DEFAULT_CACHE_DIR;
  const now = deps.now ?? Date.now;
  const cachePath = join(cacheDir, CACHE_FILENAME);

  let writeQueue: Promise<void> = Promise.resolve();

  function enqueue(fn: () => Promise<void>): Promise<void> {
    const task = writeQueue.then(fn, fn);
    writeQueue = task.then(
      () => {},
      () => {},
    );
    return task;
  }

  async function atomicWrite(schema: CacheSchema): Promise<void> {
    await mkdir(cacheDir, { recursive: true, mode: 0o700 });
    const tmpPath = join(cacheDir, `.cache-${randomBytes(8).toString("hex")}.tmp`);
    await writeFile(tmpPath, JSON.stringify(schema, null, 2) + "\n", { mode: 0o600 });
    await rename(tmpPath, cachePath);
  }

  function read(providerId: string, accountKey: string): AccountCache | null {
    try {
      const schema = readSchemaSync(cachePath);
      const entry = schema.providers[providerId]?.accounts[accountKey];
      if (!entry) return null;
      if (now() - entry.timestamp > STALENESS_CEILING_MS) return null;
      return entry;
    } catch {
      return null;
    }
  }

  function readLatest(providerId: string): { accountKey: string; entry: AccountCache } | null {
    try {
      const schema = readSchemaSync(cachePath);
      const accounts = schema.providers[providerId]?.accounts;
      if (!accounts) return null;
      const currentTime = now();
      let best: { accountKey: string; entry: AccountCache } | null = null;
      for (const key of Object.keys(accounts)) {
        const entry = accounts[key];
        if (currentTime - entry.timestamp > STALENESS_CEILING_MS) continue;
        if (!best || entry.timestamp > best.entry.timestamp) {
          best = { accountKey: key, entry };
        }
      }
      return best;
    } catch {
      return null;
    }
  }

  function getAge(providerId: string, accountKey: string): number | null {
    try {
      const schema = readSchemaSync(cachePath);
      const entry = schema.providers[providerId]?.accounts[accountKey];
      if (!entry) return null;
      return now() - entry.timestamp;
    } catch {
      return null;
    }
  }

  function write(providerId: string, accountKey: string, entry: AccountCache): Promise<void> {
    return enqueue(async () => {
      const schema = await readSchemaAsync(cachePath);
      pruneExpired(schema, now());
      if (!schema.providers[providerId]) {
        schema.providers[providerId] = { accounts: {} };
      }
      schema.providers[providerId].accounts[accountKey] = entry;
      await atomicWrite(schema);
    });
  }

  function migrateUnknown(providerId: string, newAccountKey: string): Promise<void> {
    return enqueue(async () => {
      const schema = await readSchemaAsync(cachePath);
      const provider = schema.providers[providerId];
      if (!provider) return;
      const unknownEntry = provider.accounts[UNKNOWN_ACCOUNT_KEY];
      if (!unknownEntry) return;
      provider.accounts[newAccountKey] = unknownEntry;
      delete provider.accounts[UNKNOWN_ACCOUNT_KEY];
      await atomicWrite(schema);
    });
  }

  function getBackoff(providerId: string): FetchBackoff {
    const provider = readSchemaSync(cachePath).providers[providerId];
    const nextAttemptAt = provider?.nextAttemptAt;
    return {
      nextAttemptAt: nextAttemptAt !== undefined && nextAttemptAt > now() ? nextAttemptAt : null,
      failureStreak: provider?.failureStreak ?? 0,
    };
  }

  function setBackoff(providerId: string, backoff: FetchBackoff | null): Promise<void> {
    return enqueue(async () => {
      const schema = await readSchemaAsync(cachePath);
      pruneExpired(schema, now());
      const provider = schema.providers[providerId];
      if (backoff === null) {
        if (!provider) return;
        delete provider.nextAttemptAt;
        delete provider.failureStreak;
      } else {
        const target = provider ?? (schema.providers[providerId] = { accounts: {} });
        if (backoff.nextAttemptAt === null) delete target.nextAttemptAt;
        else target.nextAttemptAt = backoff.nextAttemptAt;
        target.failureStreak = backoff.failureStreak;
      }
      await atomicWrite(schema);
    });
  }

  function lockPath(providerId: string): string {
    return join(cacheDir, `${providerId}.fetch.lock`);
  }

  function readLockToken(path: string): { token: string; expiresAt: number } | null {
    try {
      const data = JSON.parse(readFileSync(path, "utf8"));
      return typeof data?.token === "string" && typeof data?.expiresAt === "number" ? data : null;
    } catch {
      return null;
    }
  }

  function removeFile(path: string): boolean {
    try {
      unlinkSync(path);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
  }

  /**
   * Takes the cross-process lock that elects a single fetcher per provider. Returns a
   * release function, or `null` while another process holds an unexpired lock. When
   * the lock file itself cannot be managed the caller proceeds unlocked, so a broken
   * cache directory never blocks fetching.
   */
  function tryAcquireFetchLock(providerId: string, ttlMs: number): (() => void) | null {
    const path = lockPath(providerId);
    const token = randomBytes(8).toString("hex");
    const body = JSON.stringify({ pid: process.pid, token, expiresAt: now() + ttlMs });
    const release = () => {
      if (readLockToken(path)?.token === token) removeFile(path);
    };

    const create = (): boolean => {
      try {
        writeFileSync(path, body, { flag: "wx", mode: 0o600 });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
      }
    };

    try {
      mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
      if (create()) return release;
      const held = readLockToken(path);
      if (held && held.expiresAt > now()) return null;
      return removeFile(path) && create() ? release : null;
    } catch {
      return () => {};
    }
  }

  return {
    read,
    readLatest,
    write,
    getAge,
    migrateUnknown,
    getBackoff,
    setBackoff,
    tryAcquireFetchLock,
  };
}

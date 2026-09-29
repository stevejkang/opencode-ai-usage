import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AccountCache, CacheSchema, CacheStore } from "./types";
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
    const coolingDown = (provider.rateLimitedUntil ?? 0) > currentTime;
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

  function getRateLimitedUntil(providerId: string): number | null {
    const until = readSchemaSync(cachePath).providers[providerId]?.rateLimitedUntil;
    return until !== undefined && until > now() ? until : null;
  }

  function setRateLimitedUntil(providerId: string, until: number): Promise<void> {
    return enqueue(async () => {
      const schema = await readSchemaAsync(cachePath);
      pruneExpired(schema, now());
      const provider = (schema.providers[providerId] ??= { accounts: {} });
      provider.rateLimitedUntil = Math.max(provider.rateLimitedUntil ?? 0, until);
      await atomicWrite(schema);
    });
  }

  return {
    read,
    readLatest,
    write,
    getAge,
    migrateUnknown,
    getRateLimitedUntil,
    setRateLimitedUntil,
  };
}

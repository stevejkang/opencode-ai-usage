import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCacheStore } from "../src/cache";
import type { AccountCache } from "../src/types";
import { UNKNOWN_ACCOUNT_KEY } from "../src/types";

const STALENESS_CEILING_MS = 60 * 60 * 1000;

function makeEntry(overrides: Partial<AccountCache> = {}): AccountCache {
  return {
    timestamp: Date.now(),
    windows: [],
    profile: null,
    extras: null,
    ...overrides,
  };
}

describe("createCacheStore", () => {
  let tmpDir: string;
  let frozenNow: number;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "cache-test-"));
    frozenNow = 1_700_000_000_000;
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("read/write roundtrip per provider per account", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entry = makeEntry({ timestamp: frozenNow });

    await store.write("claude", "user@example.com", entry);

    expect(store.read("claude", "user@example.com")).toEqual(entry);
  });

  it("isolates providers and accounts", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entryA = makeEntry({ timestamp: frozenNow, extras: "a" });
    const entryB = makeEntry({ timestamp: frozenNow, extras: "b" });

    await store.write("claude", "alice@test.com", entryA);
    await store.write("openai", "bob@test.com", entryB);

    expect(store.read("claude", "alice@test.com")).toEqual(entryA);
    expect(store.read("openai", "bob@test.com")).toEqual(entryB);
    expect(store.read("claude", "bob@test.com")).toBeNull();
    expect(store.read("openai", "alice@test.com")).toBeNull();
  });

  it("entry at 9min59s is readable", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const nineMin59s = 9 * 60 * 1000 + 59 * 1000;
    const entry = makeEntry({ timestamp: frozenNow - nineMin59s });

    await store.write("claude", "user@test.com", entry);

    expect(store.read("claude", "user@test.com")).toEqual(entry);
  });

  it("entry at 59min59s is readable (within staleness ceiling)", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entry = makeEntry({ timestamp: frozenNow - (STALENESS_CEILING_MS - 1000) });

    await store.write("claude", "user@test.com", entry);

    expect(store.read("claude", "user@test.com")).toEqual(entry);
  });

  it("entry past staleness ceiling (>1hr) treated as absent", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entry = makeEntry({ timestamp: frozenNow - STALENESS_CEILING_MS - 1 });

    await store.write("claude", "user@test.com", entry);

    expect(store.read("claude", "user@test.com")).toBeNull();
  });

  it("getAge returns correct age in ms", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const fiveMin = 5 * 60 * 1000;
    const entry = makeEntry({ timestamp: frozenNow - fiveMin });

    await store.write("claude", "user@test.com", entry);

    expect(store.getAge("claude", "user@test.com")).toBe(fiveMin);
  });

  it("getAge returns null for missing entry", () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    expect(store.getAge("nonexistent", "nobody")).toBeNull();
  });

  it("concurrent writes from different providers both persist", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entryA = makeEntry({ timestamp: frozenNow, extras: "claude-data" });
    const entryB = makeEntry({ timestamp: frozenNow, extras: "openai-data" });

    await Promise.all([
      store.write("claude", "user@a.com", entryA),
      store.write("openai", "user@b.com", entryB),
    ]);

    expect(store.read("claude", "user@a.com")).toEqual(entryA);
    expect(store.read("openai", "user@b.com")).toEqual(entryB);
  });

  it("malformed cache.json → read returns null, write still succeeds", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    await writeFile(join(tmpDir, "cache.json"), "not json at all!!!");
    expect(store.read("claude", "user@test.com")).toBeNull();

    const entry = makeEntry({ timestamp: frozenNow });
    await store.write("claude", "user@test.com", entry);

    expect(store.read("claude", "user@test.com")).toEqual(entry);
  });

  it("migrateUnknown moves entry from __unknown__ to new key", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entry = makeEntry({ timestamp: frozenNow });

    await store.write("claude", UNKNOWN_ACCOUNT_KEY, entry);
    expect(store.read("claude", UNKNOWN_ACCOUNT_KEY)).toEqual(entry);

    await store.migrateUnknown("claude", "user@real.com");

    expect(store.read("claude", UNKNOWN_ACCOUNT_KEY)).toBeNull();
    expect(store.read("claude", "user@real.com")).toEqual(entry);
  });

  it("migrateUnknown with no __unknown__ entry is a no-op", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    await expect(store.migrateUnknown("claude", "user@test.com")).resolves.toBeUndefined();
  });

  it("migrateUnknown with nonexistent provider is a no-op", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
    const entry = makeEntry({ timestamp: frozenNow });
    await store.write("openai", "user@test.com", entry);

    await expect(store.migrateUnknown("claude", "user@test.com")).resolves.toBeUndefined();
  });

  if (process.platform !== "win32") {
    it("written file has 0o600 permissions", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

      await store.write("claude", "user@test.com", makeEntry({ timestamp: frozenNow }));

      const fileStat = await stat(join(tmpDir, "cache.json"));
      expect(fileStat.mode & 0o777).toBe(0o600);
    });
  }

  it("no tmp file leftovers after writes", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    await store.write("claude", "user@test.com", makeEntry({ timestamp: frozenNow }));
    await store.write("openai", "user@test.com", makeEntry({ timestamp: frozenNow }));

    const files = await readdir(tmpDir);
    const tmpFiles = files.filter((f) => f.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("prunes expired entries on write", async () => {
    let currentTime = frozenNow;
    const store = createCacheStore({ cacheDir: tmpDir, now: () => currentTime });

    await store.write("claude", "old@test.com", makeEntry({ timestamp: frozenNow }));

    currentTime = frozenNow + STALENESS_CEILING_MS + 1;
    await store.write("claude", "new@test.com", makeEntry({ timestamp: currentTime }));

    const raw = await readFile(join(tmpDir, "cache.json"), "utf8");
    const schema = JSON.parse(raw);
    expect(schema.providers.claude.accounts["old@test.com"]).toBeUndefined();
    expect(schema.providers.claude.accounts["new@test.com"]).toBeDefined();
  });

  it("unknown schema version treated as empty", async () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    await writeFile(
      join(tmpDir, "cache.json"),
      JSON.stringify({ version: 99, providers: { claude: { accounts: {} } } }),
    );

    expect(store.read("claude", "user@test.com")).toBeNull();
  });

  it("read returns null when no cache file exists", () => {
    const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

    expect(store.read("claude", "user@test.com")).toBeNull();
  });

  it("creates cache directory if it does not exist", async () => {
    const nestedDir = join(tmpDir, "nested", "deep");
    const store = createCacheStore({ cacheDir: nestedDir, now: () => frozenNow });

    await store.write("claude", "user@test.com", makeEntry({ timestamp: frozenNow }));

    const fileStat = await stat(join(nestedDir, "cache.json"));
    expect(fileStat.isFile()).toBe(true);
  });

  describe("readLatest", () => {
    it("returns the freshest entry across multiple accounts", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
      const older = makeEntry({ timestamp: frozenNow - 30_000, extras: "older" });
      const newer = makeEntry({ timestamp: frozenNow - 10_000, extras: "newer" });

      await store.write("claude", "old@test.com", older);
      await store.write("claude", "new@test.com", newer);

      const result = store.readLatest("claude");
      expect(result).not.toBeNull();
      expect(result!.accountKey).toBe("new@test.com");
      expect(result!.entry).toEqual(newer);
    });

    it("returns null when all entries are expired", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
      const expired = makeEntry({ timestamp: frozenNow - STALENESS_CEILING_MS - 1 });

      await store.write("claude", "user@test.com", expired);

      expect(store.readLatest("claude")).toBeNull();
    });

    it("returns null for unknown provider", () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

      expect(store.readLatest("nonexistent")).toBeNull();
    });

    it("works with a single account", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
      const entry = makeEntry({ timestamp: frozenNow, extras: "only" });

      await store.write("claude", "solo@test.com", entry);

      const result = store.readLatest("claude");
      expect(result).not.toBeNull();
      expect(result!.accountKey).toBe("solo@test.com");
      expect(result!.entry).toEqual(entry);
    });
  });

  describe("shared fetch backoff", () => {
    it("reports the backoff while nextAttemptAt is in the future and keeps the streak", async () => {
      let currentTime = frozenNow;
      const store = createCacheStore({ cacheDir: tmpDir, now: () => currentTime });

      await store.setBackoff("claude", { nextAttemptAt: frozenNow + 60_000, failureStreak: 2 });

      expect(store.getBackoff("claude")).toEqual({
        nextAttemptAt: frozenNow + 60_000,
        failureStreak: 2,
      });
      currentTime = frozenNow + 60_000;
      expect(store.getBackoff("claude")).toEqual({ nextAttemptAt: null, failureStreak: 2 });
    });

    it("clears the backoff", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

      await store.setBackoff("claude", { nextAttemptAt: frozenNow + 60_000, failureStreak: 1 });
      await store.setBackoff("claude", null);

      expect(store.getBackoff("claude")).toEqual({ nextAttemptAt: null, failureStreak: 0 });
    });

    it("survives account writes and pruning of a provider with no accounts", async () => {
      const store = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

      await store.setBackoff("claude", { nextAttemptAt: frozenNow + 60_000, failureStreak: 1 });
      await store.write("openai", "a@test.com", makeEntry({ timestamp: frozenNow }));

      expect(store.getBackoff("claude").nextAttemptAt).toBe(frozenNow + 60_000);
      expect(store.getBackoff("openai")).toEqual({ nextAttemptAt: null, failureStreak: 0 });
    });
  });

  describe("fetch lock", () => {
    it("grants the lock to one holder until it is released", () => {
      const a = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });
      const b = createCacheStore({ cacheDir: tmpDir, now: () => frozenNow });

      const release = a.tryAcquireFetchLock("claude", 60_000);

      expect(release).not.toBeNull();
      expect(b.tryAcquireFetchLock("claude", 60_000)).toBeNull();
      expect(b.tryAcquireFetchLock("openai", 60_000)).not.toBeNull();
      release!();
      expect(b.tryAcquireFetchLock("claude", 60_000)).not.toBeNull();
    });

    it("takes over an expired lock and ignores the stale holder's release", () => {
      let currentTime = frozenNow;
      const store = createCacheStore({ cacheDir: tmpDir, now: () => currentTime });

      const staleRelease = store.tryAcquireFetchLock("claude", 60_000)!;
      currentTime += 60_001;
      const release = store.tryAcquireFetchLock("claude", 60_000);

      expect(release).not.toBeNull();
      staleRelease();
      expect(store.tryAcquireFetchLock("claude", 60_000)).toBeNull();
    });

    it("lets the caller proceed unlocked when the lock file cannot be created", async () => {
      const blocker = join(tmpDir, "blocker");
      await writeFile(blocker, "");
      const store = createCacheStore({ cacheDir: join(blocker, "sub"), now: () => frozenNow });

      expect(store.tryAcquireFetchLock("claude", 60_000)).toEqual(expect.any(Function));
    });
  });
});

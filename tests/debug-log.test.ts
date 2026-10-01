import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDebugLog,
  debugLogPath,
  describeProcess,
  resolveDebugLogConfig,
} from "../src/debug-log";

const FROZEN_NOW = 1_700_000_000_000;
const DAY_MS = 24 * 60 * 60 * 1000;

describe("resolveDebugLogConfig", () => {
  it("is disabled with 7-day retention and 10MB files by default", () => {
    expect(resolveDebugLogConfig(undefined)).toEqual({
      enabled: false,
      retentionDays: 7,
      maxFileBytes: 10 * 1024 * 1024,
    });
  });

  it("applies valid overrides and falls back on invalid values", () => {
    expect(resolveDebugLogConfig({ enabled: true, retentionDays: 3, maxFileSizeMB: 1 })).toEqual({
      enabled: true,
      retentionDays: 3,
      maxFileBytes: 1024 * 1024,
    });
    expect(resolveDebugLogConfig({ retentionDays: -1, maxFileSizeMB: Number.NaN })).toEqual({
      enabled: false,
      retentionDays: 7,
      maxFileBytes: 10 * 1024 * 1024,
    });
  });
});

describe("createDebugLog", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "debug-log-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("appends one JSON line per event with ts, pid, ppid and fields", async () => {
    const log = createDebugLog({ logDir: tmpDir, pid: 111, ppid: 222, now: () => FROZEN_NOW });

    log("cycle.start", { provider: "claude", cycle: 1 });
    log("plugin.dispose");

    const lines = (await readFile(debugLogPath(tmpDir, FROZEN_NOW), "utf8")).trim().split("\n");
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      {
        ts: new Date(FROZEN_NOW).toISOString(),
        pid: 111,
        ppid: 222,
        event: "cycle.start",
        provider: "claude",
        cycle: 1,
      },
      { ts: new Date(FROZEN_NOW).toISOString(), pid: 111, ppid: 222, event: "plugin.dispose" },
    ]);
  });

  it("writes one file per UTC day", async () => {
    let now = FROZEN_NOW;
    const log = createDebugLog({ logDir: tmpDir, now: () => now });

    log("first");
    now += DAY_MS;
    log("second");

    expect(debugLogPath(tmpDir, FROZEN_NOW)).toMatch(/debug-2023-11-14\.log$/);
    expect(JSON.parse(await readFile(debugLogPath(tmpDir, FROZEN_NOW), "utf8")).event).toBe(
      "first",
    );
    expect(JSON.parse(await readFile(debugLogPath(tmpDir, now), "utf8")).event).toBe("second");
  });

  it("moves a full file aside with a timestamp suffix", async () => {
    const log = createDebugLog({ logDir: tmpDir, maxFileBytes: 50, now: () => FROZEN_NOW });
    const path = debugLogPath(tmpDir, FROZEN_NOW);

    log("first", { padding: "x".repeat(60) });
    log("second");

    const rotated = await readFile(path.replace(/\.log$/, `.${FROZEN_NOW}.log`), "utf8");
    expect(JSON.parse(rotated.trim()).event).toBe("first");
    expect(JSON.parse((await readFile(path, "utf8")).trim()).event).toBe("second");
  });

  it("deletes log files untouched for longer than the retention period", async () => {
    const old = new Date(FROZEN_NOW - 8 * DAY_MS);
    const recent = new Date(FROZEN_NOW - 2 * DAY_MS);
    for (const [name, mtime] of [
      ["debug-2023-11-06.log", old],
      ["debug.log.1", old],
      ["debug-2023-11-12.log", recent],
      ["cache.json", old],
    ] as const) {
      await writeFile(join(tmpDir, name), "x");
      await utimes(join(tmpDir, name), mtime, mtime);
    }

    createDebugLog({ logDir: tmpDir, retentionDays: 7, now: () => FROZEN_NOW })("plugin.init");

    expect((await readdir(tmpDir)).sort()).toEqual([
      "cache.json",
      "debug-2023-11-12.log",
      "debug-2023-11-14.log",
    ]);
  });

  it("creates the log file with owner-only permissions", async () => {
    const log = createDebugLog({ logDir: tmpDir, now: () => FROZEN_NOW });

    log("plugin.init");

    const mode = (await stat(debugLogPath(tmpDir, FROZEN_NOW))).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("stops logging silently when the log path is unwritable", async () => {
    const blocker = join(tmpDir, "blocker");
    await writeFile(blocker, "");
    const brokenLog = createDebugLog({ logDir: join(blocker, "sub") });

    expect(() => brokenLog("event")).not.toThrow();
  });
});

describe("describeProcess", () => {
  it("reports argv, execPath and the trimmed parent command", () => {
    const readCommand = vi.fn(() => "/usr/local/bin/opencode --port 4096\n");

    const info = describeProcess({
      argv: ["/usr/bin/bun", "tui.tsx"],
      execPath: "/usr/bin/bun",
      ppid: 42,
      readCommand,
    });

    expect(readCommand).toHaveBeenCalledWith(42);
    expect(info).toEqual({
      argv: ["/usr/bin/bun", "tui.tsx"],
      execPath: "/usr/bin/bun",
      parentCommand: "/usr/local/bin/opencode --port 4096",
    });
  });

  it("returns null parentCommand when the parent cannot be resolved", () => {
    const info = describeProcess({
      ppid: 42,
      readCommand: () => {
        throw new Error("no such process");
      },
    });

    expect(info.parentCommand).toBeNull();
  });

  it("resolves the real parent command via ps", () => {
    expect(describeProcess().parentCommand).toEqual(expect.any(String));
  });
});

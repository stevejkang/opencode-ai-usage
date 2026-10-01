import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DebugLogOptions } from "./types";

const DEFAULT_LOG_DIR = join(homedir(), ".cache", "opencode-ai-usage");
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_FILE_SIZE_MB = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_PATTERN = /^debug[-.].*log/;

export type DebugLog = (event: string, fields?: Record<string, unknown>) => void;

export interface DebugLogConfig {
  enabled: boolean;
  retentionDays: number;
  maxFileBytes: number;
}

export interface DebugLogDeps {
  logDir?: string;
  pid?: number;
  ppid?: number;
  now?: () => number;
  maxFileBytes?: number;
  retentionDays?: number;
}

function positiveOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Resolves the `debugLog` plugin option; logging is off unless `enabled` is `true`. */
export function resolveDebugLogConfig(raw: DebugLogOptions | undefined): DebugLogConfig {
  return {
    enabled: raw?.enabled === true,
    retentionDays: positiveOr(raw?.retentionDays, DEFAULT_RETENTION_DAYS),
    maxFileBytes: positiveOr(raw?.maxFileSizeMB, DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024,
  };
}

/** Directory holding the shared JSONL debug logs written by every OpenCode process. */
export function debugLogDir(): string {
  return DEFAULT_LOG_DIR;
}

/** Path of the log file that receives lines written at `at`; one file per UTC day. */
export function debugLogPath(logDir: string, at: number): string {
  return join(logDir, `debug-${new Date(at).toISOString().slice(0, 10)}.log`);
}

function pruneExpiredLogs(logDir: string, cutoff: number): void {
  for (const name of readdirSync(logDir)) {
    if (!LOG_FILE_PATTERN.test(name)) continue;
    const path = join(logDir, name);
    try {
      if (statSync(path).mtimeMs < cutoff) unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Creates an append-only JSONL logger writing `debug-YYYY-MM-DD.log` files. Each line
 * carries `pid`/`ppid` because several OpenCode processes share the same directory.
 * A file reaching `maxFileBytes` is renamed aside with a timestamp suffix, and files
 * untouched for `retentionDays` are deleted at startup and on each UTC day change.
 * Logging failures disable the logger instead of throwing, so diagnostics can never
 * break the sidebar.
 */
export function createDebugLog(deps: DebugLogDeps = {}): DebugLog {
  const logDir = deps.logDir ?? DEFAULT_LOG_DIR;
  const pid = deps.pid ?? process.pid;
  const ppid = deps.ppid ?? process.ppid;
  const now = deps.now ?? Date.now;
  const maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_SIZE_MB * 1024 * 1024;
  const retentionMs = (deps.retentionDays ?? DEFAULT_RETENTION_DAYS) * DAY_MS;
  let disabled = false;
  let currentPath: string | null = null;

  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
  } catch {
    disabled = true;
  }

  function pathFor(at: number): string {
    const path = debugLogPath(logDir, at);
    if (path !== currentPath) {
      currentPath = path;
      pruneExpiredLogs(logDir, at - retentionMs);
    }
    return path;
  }

  function rotateIfNeeded(path: string, at: number): void {
    try {
      if (statSync(path).size >= maxFileBytes) {
        renameSync(path, path.replace(/\.log$/, `.${at}.log`));
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return (event, fields = {}) => {
    if (disabled) return;
    try {
      const at = now();
      const path = pathFor(at);
      rotateIfNeeded(path, at);
      const line = JSON.stringify({ ts: new Date(at).toISOString(), pid, ppid, event, ...fields });
      appendFileSync(path, line + "\n", { mode: 0o600 });
    } catch {
      disabled = true;
    }
  };
}

export interface ProcessInfo {
  argv: string[];
  execPath: string;
  parentCommand: string | null;
}

export interface ProcessInfoDeps {
  argv?: string[];
  execPath?: string;
  ppid?: number;
  readCommand?: (pid: number) => string;
}

function readCommandViaPs(pid: number): string {
  return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    timeout: 1000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Describes how the current process was launched, including the parent's command line,
 * so log lines can be attributed to a specific OpenCode instance. Meant to be logged
 * once per process because resolving the parent spawns `ps`.
 */
export function describeProcess(deps: ProcessInfoDeps = {}): ProcessInfo {
  const ppid = deps.ppid ?? process.ppid;
  const readCommand = deps.readCommand ?? readCommandViaPs;
  let parentCommand: string | null = null;
  try {
    parentCommand = readCommand(ppid).trim() || null;
  } catch {
    parentCommand = null;
  }
  return {
    argv: deps.argv ?? process.argv,
    execPath: deps.execPath ?? process.execPath,
    parentCommand,
  };
}

/** Logger that discards everything; used when debug logging is disabled. */
export const noopDebugLog: DebugLog = () => {};

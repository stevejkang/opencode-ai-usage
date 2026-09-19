import type { ProviderDeps, FetchResult, DetectionResult, UsageWindow } from "../../types";
import { toUnixMs, toPercent, ProviderFetchError } from "../../types";
import { formatWindowLabel } from "../../format";
import type {
  RateLimitSnapshot,
  RateLimitResponse,
  RateLimitWindow,
  AccountResponse,
} from "./types";

const RPC_TIMEOUT_MS = 15_000;

export async function detect(deps: ProviderDeps, _signal: AbortSignal): Promise<DetectionResult> {
  try {
    const raw = deps.exec("which codex", { encoding: "utf8" });
    const path = String(raw).trim();
    if (path.length > 0) {
      return { available: true };
    }
    return { available: false, reason: "Codex CLI not found in PATH" };
  } catch {
    return { available: false, reason: "Codex CLI not found in PATH" };
  }
}

export async function fetchUsage(
  deps: ProviderDeps,
  signal: AbortSignal,
): Promise<FetchResult<null>> {
  return new Promise<FetchResult<null>>((resolve, reject) => {
    let settled = false;

    const codexPath = String(deps.exec("which codex", { encoding: "utf8" })).trim();

    const child = deps.spawn(codexPath, ["app-server", "--listen", "stdio://"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const killChild = () => {
      try {
        child.kill();
      } catch {
        /* already dead */
      }
    };

    const finish = (fn: typeof resolve | typeof reject, value: FetchResult<null> | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (profileGraceTimer) clearTimeout(profileGraceTimer);
      onAbort();
      killChild();
      (fn as (v: FetchResult<null> | Error) => void)(value);
    };

    const timeout = setTimeout(() => {
      finish(reject, new ProviderFetchError("Codex RPC timed out after 15s", { kind: "network" }));
    }, RPC_TIMEOUT_MS);

    const onAbortHandler = () => {
      finish(reject, new ProviderFetchError("Fetch aborted", { kind: "network" }));
    };

    signal.addEventListener("abort", onAbortHandler);
    const onAbort = () => signal.removeEventListener("abort", onAbortHandler);

    let buffer = "";
    let snapshot: RateLimitSnapshot | null = null;
    let profile: { email: string | null; planType: string | null } | null = null;
    let profileArrived = false;
    let profileGraceTimer: ReturnType<typeof setTimeout> | null = null;

    const PROFILE_GRACE_MS = 1_000;

    const finalize = () => {
      const windows = snapshotToWindows(snapshot);
      const email = profile?.email ?? null;
      finish(resolve, {
        accountKey: email,
        windows,
        profile: profile ? { email: profile.email, plan: profile.planType } : null,
        extras: null,
      });
    };

    const settle = (): void => {
      if (snapshot === null) return;
      if (!profileArrived) {
        if (profileGraceTimer === null) {
          profileGraceTimer = setTimeout(finalize, PROFILE_GRACE_MS);
        }
        return;
      }
      finalize();
    };

    child.on("error", (err: NodeJS.ErrnoException) => {
      const message =
        err.code === "ENOENT" ? "Codex CLI not found" : `Codex spawn error: ${err.message}`;
      finish(reject, new ProviderFetchError(message, { kind: "network" }));
    });

    child.stdout!.on("data", (chunk: Buffer) => {
      if (settled) return;
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        let msg: { id?: number; result?: unknown; error?: unknown; method?: string };
        try {
          msg = JSON.parse(line);
        } catch {
          finish(
            reject,
            new ProviderFetchError(`Malformed JSON from Codex RPC: ${line}`, {
              kind: "network",
            }),
          );
          return;
        }

        if (msg.id === 1) {
          child.stdin!.write(JSON.stringify({ method: "initialized" }) + "\n");
          child.stdin!.write(JSON.stringify({ method: "account/rateLimits/read", id: 2 }) + "\n");
          child.stdin!.write(JSON.stringify({ method: "account/read", id: 3, params: {} }) + "\n");
        } else if (msg.id === 2) {
          const response = msg.result as RateLimitResponse | undefined;
          snapshot = response?.rateLimits ?? ({} as RateLimitSnapshot);
          normalizeUsedPercent(snapshot);
          settle();
        } else if (msg.id === 3) {
          profileArrived = true;
          if (!msg.error) {
            const account = (msg.result as AccountResponse | undefined)?.account;
            if (account?.type === "chatgpt" && account.email) {
              profile = {
                email: account.email,
                planType: account.planType ?? null,
              };
            }
          }
          settle();
        }
      }
    });

    child.stdin!.write(
      JSON.stringify({
        method: "initialize",
        id: 1,
        params: {
          clientInfo: {
            name: "opencode_openai_usage",
            title: "OpenCode OpenAI Usage",
            version: "0.2.0",
          },
        },
      }) + "\n",
    );
  });
}

export function normalizeUsedPercent(snapshot: RateLimitSnapshot): void {
  normalizeWindowPercent(snapshot.primary);
  normalizeWindowPercent(snapshot.secondary);
}

function normalizeWindowPercent(window: RateLimitWindow | null | undefined): void {
  if (!window || window.usedPercent == null) return;
  if (window.usedPercent > 0 && window.usedPercent < 1) {
    window.usedPercent *= 100;
  }
}

function windowToUsageWindow(win: RateLimitWindow | null | undefined): UsageWindow | null {
  if (!win) return null;

  const percent = win.usedPercent != null ? toPercent(win.usedPercent) : null;
  const resetsAt = win.resetsAt != null ? toUnixMs(win.resetsAt * 1000) : null;
  const label = formatWindowLabel(win.windowDurationMins);
  const isActive = percent !== null && (percent > 0 || resetsAt !== null);

  return { label, percent, resetsAt, isActive };
}

function snapshotToWindows(snapshot: RateLimitSnapshot | null): UsageWindow[] {
  if (!snapshot) return [];

  const windows: UsageWindow[] = [];

  const primary = windowToUsageWindow(snapshot.primary);
  if (primary) windows.push(primary);

  const secondary = windowToUsageWindow(snapshot.secondary);
  if (secondary) windows.push(secondary);

  return windows;
}

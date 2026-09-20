import type { ProviderDeps, FetchResult, DetectionResult, UsageWindow } from "../../types";
import { toUnixMs, toPercent, ProviderFetchError } from "../../types";
import type { ApiResponse, AuthJson, WindowMetric } from "./types";
import { join } from "node:path";

const USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const FETCH_TIMEOUT_MS = 30_000;

const WINDOW_LABELS: Record<string, string> = {
  rolling: "Session",
  weekly: "Weekly",
  monthly: "Monthly",
};

function dataDir(homedir: string): string {
  if (process.platform === "win32") {
    return process.env.APPDATA ?? join(homedir, "AppData", "Roaming");
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) return xdg;
  return join(homedir, ".local", "share");
}

function authPath(homedir: string): string {
  return join(dataDir(homedir), "opencode", "auth.json");
}

function readAuthFile(deps: Pick<ProviderDeps, "readFile" | "homedir">): string | null {
  try {
    const raw = deps.readFile(authPath(deps.homedir()), "utf8");
    const parsed = JSON.parse(raw) as AuthJson;
    const entry = parsed["opencode-go"];
    const key = entry?.key;
    if (typeof key === "string" && key.trim().length > 0) return key.trim();
  } catch {
    /* file missing or malformed */
  }
  return null;
}

function readEnvKey(): string | null {
  const key = process.env.OPENCODE_API_KEY;
  if (typeof key === "string" && key.trim().length > 0) return key.trim();
  return null;
}

export function readApiKey(deps: Pick<ProviderDeps, "readFile" | "homedir">): string | null {
  return readAuthFile(deps) ?? readEnvKey();
}

export async function detect(deps: ProviderDeps, _signal: AbortSignal): Promise<DetectionResult> {
  const key = readApiKey(deps);
  if (key) return { available: true };
  return { available: false, reason: "No OpenCode Go credentials found" };
}

function metricToWindow(key: string, metric: WindowMetric | null | undefined): UsageWindow | null {
  if (!metric) return null;

  const label = WINDOW_LABELS[key] ?? key;
  const percent = metric.percent != null ? toPercent(metric.percent) : null;

  let resetsAt: ReturnType<typeof toUnixMs> | null = null;
  if (metric.resetsAt) {
    const parsed = new Date(metric.resetsAt).getTime();
    if (!Number.isNaN(parsed)) {
      resetsAt = toUnixMs(parsed);
    }
  }

  const isActive = percent !== null && (percent > 0 || resetsAt !== null);
  return { label, percent, resetsAt, isActive };
}

export async function fetchUsage(
  deps: ProviderDeps,
  signal: AbortSignal,
): Promise<FetchResult<null>> {
  const apiKey = readApiKey(deps);
  if (!apiKey) {
    throw new ProviderFetchError("No OpenCode Go credentials found", {
      kind: "network",
    });
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort);

  let response: Response;
  try {
    response = await deps.fetch(USAGE_URL, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } catch {
    if (signal.aborted) {
      throw new ProviderFetchError("Fetch aborted", { kind: "network" });
    }
    if (timedOut) {
      throw new ProviderFetchError("OpenCode Go usage request timed out", {
        kind: "network",
      });
    }
    throw new ProviderFetchError("Network error fetching OpenCode Go usage", {
      kind: "network",
    });
  } finally {
    clearTimeout(timeout);
    signal.removeEventListener("abort", onAbort);
  }

  if (response.status === 401) {
    throw new ProviderFetchError("OpenCode Go API key rejected (401)", {
      kind: "http",
      status: 401,
    });
  }

  if (response.status === 403) {
    return { accountKey: null, windows: [], profile: null, extras: null };
  }

  if (response.status === 429) {
    const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "0", 10);
    throw new ProviderFetchError("Rate limited (429)", {
      kind: "http",
      status: 429,
      retryAfterS: retryAfter > 0 ? retryAfter : 60,
    });
  }

  if (!response.ok) {
    throw new ProviderFetchError(`HTTP ${response.status}`, {
      kind: "http",
      status: response.status,
    });
  }

  const data = (await response.json()) as ApiResponse;

  const windows: UsageWindow[] = [];
  if (data.usage) {
    for (const key of ["rolling", "weekly", "monthly"] as const) {
      const win = metricToWindow(key, data.usage[key]);
      if (win) windows.push(win);
    }
  }

  return { accountKey: null, windows, profile: null, extras: null };
}

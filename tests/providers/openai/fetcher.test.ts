import { EventEmitter } from "node:events";
import type { Writable } from "node:stream";
import { detect, fetchUsage, normalizeUsedPercent } from "../../../src/providers/openai/fetcher";
import type { ProviderDeps } from "../../../src/types";
import type { RateLimitSnapshot } from "../../../src/providers/openai/types";

interface FakeChild extends EventEmitter {
  stdin: Writable & { written: string[] };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  pid: number;
}

function createFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;

  const written: string[] = [];
  child.stdin = {
    written,
    write(data: string | Buffer) {
      written.push(typeof data === "string" ? data : data.toString());
      return true;
    },
    end() {},
    on() {
      return this;
    },
    once() {
      return this;
    },
    emit() {
      return false;
    },
  } as unknown as FakeChild["stdin"];
  child.stdin.written = written;

  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  child.pid = 12345;

  return child;
}

function rpcLine(obj: Record<string, unknown>): string {
  return JSON.stringify(obj) + "\n";
}

function initializeResponse(): string {
  return rpcLine({ id: 1, result: { capabilities: {} } });
}

function rateLimitsResponse(snapshot: RateLimitSnapshot): string {
  return rpcLine({ id: 2, result: { rateLimits: snapshot } });
}

function accountResponse(email: string | null, planType: string | null = null): string {
  return rpcLine({
    id: 3,
    result: {
      account: email ? { type: "chatgpt", email, planType } : null,
    },
  });
}

function scriptedChild(
  snapshot: RateLimitSnapshot,
  email: string | null = "user@example.com",
  planType: string | null = "plus",
): FakeChild {
  const child = createFakeChild();

  child.stdout.on("newListener", (event: string) => {
    if (event !== "data") return;
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(initializeResponse()));
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(rateLimitsResponse(snapshot) + accountResponse(email, planType)),
        );
      });
    });
  });

  return child;
}

function createFakeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    exec: vi.fn().mockReturnValue("/usr/local/bin/codex\n") as unknown as ProviderDeps["exec"],
    execFile: vi.fn() as unknown as ProviderDeps["execFile"],
    spawn: vi.fn() as unknown as ProviderDeps["spawn"],
    readFile: vi.fn() as unknown as ProviderDeps["readFile"],
    fetch: vi.fn() as unknown as ProviderDeps["fetch"],
    now: () => Date.now(),
    homedir: () => "/home/test",
    ...overrides,
  };
}

describe("detect", () => {
  it("returns available when codex binary is found", async () => {
    const deps = createFakeDeps({
      exec: vi.fn().mockReturnValue("/usr/local/bin/codex\n") as unknown as ProviderDeps["exec"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({ available: true });
  });

  it("returns unavailable when which codex throws", async () => {
    const deps = createFakeDeps({
      exec: vi.fn().mockImplementation(() => {
        throw new Error("not found");
      }) as unknown as ProviderDeps["exec"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({
      available: false,
      reason: "Codex CLI not found in PATH",
    });
  });

  it("returns unavailable when which returns empty string", async () => {
    const deps = createFakeDeps({
      exec: vi.fn().mockReturnValue("  \n") as unknown as ProviderDeps["exec"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({
      available: false,
      reason: "Codex CLI not found in PATH",
    });
  });

  it("returns unavailable when which codex succeeds but codex --version throws ENOENT", async () => {
    const execMock = vi
      .fn()
      .mockImplementationOnce(() => "/usr/local/bin/codex\n")
      .mockImplementationOnce(() => {
        const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      });
    const deps = createFakeDeps({
      exec: execMock as unknown as ProviderDeps["exec"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({
      available: false,
      reason: "Codex CLI found but not executable",
    });
    expect(execMock).toHaveBeenCalledTimes(2);
  });

  it("returns available when both which codex and codex --version succeed", async () => {
    const execMock = vi
      .fn()
      .mockImplementationOnce(() => "/usr/local/bin/codex\n")
      .mockImplementationOnce(() => "codex-cli 0.21.0\n");
    const deps = createFakeDeps({
      exec: execMock as unknown as ProviderDeps["exec"],
    });
    const result = await detect(deps, AbortSignal.abort());
    expect(result).toEqual({ available: true });
    expect(execMock).toHaveBeenCalledTimes(2);
    expect(execMock).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("codex"),
      expect.any(Object),
    );
  });
});

describe("fetchUsage", () => {
  it("happy path: returns windows and profile from scripted child", async () => {
    const child = scriptedChild(
      {
        primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1700000000 },
        secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1700500000 },
      },
      "user@example.com",
      "plus",
    );

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);

    expect(result.accountKey).toBe("user@example.com");
    expect(result.profile).toEqual({ email: "user@example.com", plan: "plus" });
    expect(result.extras).toBeNull();
    expect(result.windows).toHaveLength(2);
    expect(result.windows[0]!.label).toBe("Session");
    expect(result.windows[0]!.percent).toBe(31);
    expect(result.windows[0]!.resetsAt).toBe(1700000000 * 1000);
    expect(result.windows[1]!.label).toBe("Weekly");
    expect(result.windows[1]!.percent).toBe(11);
    expect(child.kill).toHaveBeenCalled();
  });

  it("sends correct JSON-RPC initialize payload", async () => {
    const child = scriptedChild({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1700000000 },
    });

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    await fetchUsage(deps, new AbortController().signal);

    const initMsg = JSON.parse(child.stdin.written[0]!.trim());
    expect(initMsg.method).toBe("initialize");
    expect(initMsg.id).toBe(1);
    expect(initMsg.params.clientInfo.name).toBe("opencode_openai_usage");
  });

  it("sends initialized notification then parallel reads after init response", async () => {
    const child = scriptedChild({
      primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1700000000 },
    });

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    await fetchUsage(deps, new AbortController().signal);

    expect(child.stdin.written.length).toBeGreaterThanOrEqual(4);
    const initialized = JSON.parse(child.stdin.written[1]!.trim());
    expect(initialized.method).toBe("initialized");
    const rateLimitsRead = JSON.parse(child.stdin.written[2]!.trim());
    expect(rateLimitsRead.method).toBe("account/rateLimits/read");
    expect(rateLimitsRead.id).toBe(2);
    const accountRead = JSON.parse(child.stdin.written[3]!.trim());
    expect(accountRead.method).toBe("account/read");
    expect(accountRead.id).toBe(3);
  });

  it("handles null profile (no chatgpt account)", async () => {
    const child = scriptedChild(
      { primary: { usedPercent: 50, windowDurationMins: 300, resetsAt: 1700000000 } },
      null,
    );

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.accountKey).toBeNull();
    expect(result.profile).toBeNull();
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("normalizeUsedPercent", () => {
  it("scales 0.5 to 50 (fractional → percentage)", () => {
    const s: RateLimitSnapshot = { primary: { usedPercent: 0.5 } };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBe(50);
  });

  it("leaves 31 as-is (already percentage scale)", () => {
    const s: RateLimitSnapshot = { primary: { usedPercent: 31 } };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBe(31);
  });

  it("leaves 0 as-is (strict inequality: 0 < p < 1 excludes 0)", () => {
    const s: RateLimitSnapshot = { primary: { usedPercent: 0 } };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBe(0);
  });

  it("leaves exactly 1 as-is (strict inequality: 0 < p < 1 excludes 1)", () => {
    const s: RateLimitSnapshot = { primary: { usedPercent: 1 } };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBe(1);
  });

  it("normalizes secondary window independently", () => {
    const s: RateLimitSnapshot = {
      primary: { usedPercent: 0.31 },
      secondary: { usedPercent: 0.11 },
    };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBe(31);
    expect(s.secondary!.usedPercent).toBe(11);
  });

  it("handles null/undefined windows gracefully", () => {
    const s: RateLimitSnapshot = { primary: null, secondary: undefined };
    expect(() => normalizeUsedPercent(s)).not.toThrow();
  });

  it("handles null usedPercent", () => {
    const s: RateLimitSnapshot = { primary: { usedPercent: null } };
    normalizeUsedPercent(s);
    expect(s.primary!.usedPercent).toBeNull();
  });
});

describe("dynamic windows", () => {
  it("0 windows: both primary and secondary null", async () => {
    const child = scriptedChild({ primary: null, secondary: null }, "user@example.com");

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(0);
  });

  it("1 window: only secondary (weekly)", async () => {
    const child = scriptedChild(
      {
        primary: null,
        secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 1700500000 },
      },
      "user@example.com",
    );

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(1);
    expect(result.windows[0]!.label).toBe("Weekly");
  });

  it("N windows: both primary and secondary present", async () => {
    const child = scriptedChild({
      primary: { usedPercent: 31, windowDurationMins: 300, resetsAt: 1700000000 },
      secondary: { usedPercent: 11, windowDurationMins: 10080, resetsAt: 1700500000 },
    });

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(2);
  });

  it("empty snapshot object yields 0 windows", async () => {
    const child = scriptedChild({});

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const result = await fetchUsage(deps, new AbortController().signal);
    expect(result.windows).toHaveLength(0);
  });
});

describe("abort handling", () => {
  it("kills child and settles when signal is aborted during fetch", async () => {
    const child = createFakeChild();
    const ac = new AbortController();

    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const start = Date.now();
    const promise = fetchUsage(deps, ac.signal);

    child.stdout.emit("data", Buffer.from(initializeResponse()));

    await new Promise((r) => setTimeout(r, 10));
    ac.abort();

    await expect(promise).rejects.toThrow("Fetch aborted");
    expect(child.kill).toHaveBeenCalled();
    expect(Date.now() - start).toBeLessThan(5000);
  });
});

describe("RPC timeout", () => {
  it("kills child and throws on timeout", async () => {
    vi.useFakeTimers();

    const child = createFakeChild();
    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const promise = fetchUsage(deps, new AbortController().signal);

    let caughtError: Error | null = null;
    const errorPromise = promise.catch((e: Error) => {
      caughtError = e;
    });

    await vi.advanceTimersByTimeAsync(15_000);
    await errorPromise;

    expect(caughtError).not.toBeNull();
    expect(caughtError!.message).toBe("Codex RPC timed out after 15s");
    expect(child.kill).toHaveBeenCalled();

    vi.useRealTimers();
  });
});

describe("malformed JSON-RPC response", () => {
  it("kills child and throws on invalid JSON", async () => {
    const child = createFakeChild();
    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const promise = fetchUsage(deps, new AbortController().signal);

    child.stdout.emit("data", Buffer.from("not valid json\n"));

    await expect(promise).rejects.toThrow("Malformed JSON from Codex RPC");
    expect(child.kill).toHaveBeenCalled();
  });
});

describe("child spawn error", () => {
  it("rejects with ProviderFetchError on ENOENT", async () => {
    const child = createFakeChild();
    const deps = createFakeDeps({
      spawn: vi.fn().mockReturnValue(child) as unknown as ProviderDeps["spawn"],
    });

    const promise = fetchUsage(deps, new AbortController().signal);

    const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    child.emit("error", err);

    await expect(promise).rejects.toThrow("Codex CLI not found");
  });
});

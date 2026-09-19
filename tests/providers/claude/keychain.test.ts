import type { ProviderDeps } from "../../../src/types";
import {
  parseCredentials,
  isTokenExpired,
  readCredentialsFile,
  readOpenCodeAuth,
  readKeychainCredentials,
  readEnvToken,
} from "../../../src/providers/claude/keychain";

const NOW = 1_700_000_000_000;

function makeDeps(overrides: Partial<ProviderDeps> = {}): ProviderDeps {
  return {
    exec: vi.fn(),
    execFile: vi.fn(),
    spawn: vi.fn(),
    readFile: vi.fn(),
    fetch: vi.fn(),
    now: () => NOW,
    homedir: () => "/home/test",
    ...overrides,
  };
}

describe("isTokenExpired", () => {
  it("returns false when token has time remaining", () => {
    expect(isTokenExpired(NOW + 10 * 60 * 1000, NOW)).toBe(false);
  });

  it("returns true when within 5-minute buffer", () => {
    expect(isTokenExpired(NOW + 4 * 60 * 1000, NOW)).toBe(true);
  });

  it("returns true when already expired", () => {
    expect(isTokenExpired(NOW - 1000, NOW)).toBe(true);
  });
});

describe("parseCredentials", () => {
  it("parses claudeAiOauth wrapper format", () => {
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: "tok_abc",
        refreshToken: "ref_xyz",
        expiresAt: NOW + 60 * 60 * 1000,
        scopes: ["user:profile"],
      },
    });
    const creds = parseCredentials(raw, NOW);
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("tok_abc");
    expect(creds!.hasProfileScope).toBe(true);
  });

  it("parses flat format", () => {
    const raw = JSON.stringify({
      accessToken: "tok_flat",
      refreshToken: "ref_flat",
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: [],
    });
    const creds = parseCredentials(raw, NOW);
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("tok_flat");
    expect(creds!.hasProfileScope).toBe(false);
  });

  it("returns null for expired token", () => {
    const raw = JSON.stringify({
      accessToken: "tok_old",
      expiresAt: NOW - 1000,
    });
    expect(parseCredentials(raw, NOW)).toBeNull();
  });

  it("returns null for missing accessToken", () => {
    const raw = JSON.stringify({ expiresAt: NOW + 60 * 60 * 1000 });
    expect(parseCredentials(raw, NOW)).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(parseCredentials("{bad json", NOW)).toBeNull();
  });
});

describe("readCredentialsFile", () => {
  it("reads and parses valid credentials", () => {
    const deps = makeDeps({
      readFile: vi.fn().mockReturnValue(
        JSON.stringify({
          accessToken: "tok_file",
          expiresAt: NOW + 60 * 60 * 1000,
          scopes: [],
        }),
      ),
    });
    const creds = readCredentialsFile(deps);
    expect(creds).not.toBeNull();
    expect(creds!.accessToken).toBe("tok_file");
    expect(deps.readFile).toHaveBeenCalledWith("/home/test/.claude/.credentials.json", "utf8");
  });

  it("returns null when file does not exist", () => {
    const deps = makeDeps({
      readFile: vi.fn().mockImplementation(() => {
        throw new Error("ENOENT");
      }),
    });
    expect(readCredentialsFile(deps)).toBeNull();
  });
});

describe("readOpenCodeAuth", () => {
  it("reads anthropic credentials from auth.json", () => {
    const deps = makeDeps({
      readFile: vi.fn().mockReturnValue(
        JSON.stringify({
          anthropic: {
            access: "tok_oc",
            refresh: "ref_oc",
            expires: NOW + 3600000,
          },
        }),
      ),
    });
    const auth = readOpenCodeAuth(deps);
    expect(auth).not.toBeNull();
    expect(auth!.accessToken).toBe("tok_oc");
    expect(auth!.refreshToken).toBe("ref_oc");
  });

  it("returns null when anthropic section missing", () => {
    const deps = makeDeps({
      readFile: vi.fn().mockReturnValue(JSON.stringify({ other: {} })),
    });
    expect(readOpenCodeAuth(deps)).toBeNull();
  });

  it("returns null when file read fails", () => {
    const deps = makeDeps({
      readFile: vi.fn().mockImplementation(() => {
        throw new Error("ENOENT");
      }),
    });
    expect(readOpenCodeAuth(deps)).toBeNull();
  });
});

describe("readKeychainCredentials", () => {
  const originalPlatform = process.platform;

  it("returns null on non-macOS", () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const deps = makeDeps();
      const result = readKeychainCredentials(deps);
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reads credentials from macOS keychain via execFile", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const keychainData = JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok_kc",
          refreshToken: "ref_kc",
          expiresAt: NOW + 3600000,
          scopes: ["user:profile"],
        },
      });
      const deps = makeDeps({
        execFile: vi.fn().mockReturnValue(keychainData),
      });
      const result = readKeychainCredentials(deps);
      expect(result).not.toBeNull();
      expect(result!.accessToken).toBe("tok_kc");
      expect(deps.execFile).toHaveBeenCalledWith(
        "/usr/bin/security",
        ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
        { timeout: 5000, encoding: "utf8" },
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns null when execFile throws", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const deps = makeDeps({
        execFile: vi.fn().mockImplementation(() => {
          throw new Error("not found");
        }),
      });
      const result = readKeychainCredentials(deps);
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("returns null for malformed keychain payload", () => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const deps = makeDeps({
        execFile: vi.fn().mockReturnValue("not-json"),
      });
      const result = readKeychainCredentials(deps);
      expect(result).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });
});

describe("readEnvToken", () => {
  it("reads CLAUDE_CODE_OAUTH_TOKEN from process.env", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "tok_env");
    expect(readEnvToken()).toBe("tok_env");
    vi.unstubAllEnvs();
  });

  it("returns null when env var is empty string", () => {
    vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", "");
    expect(readEnvToken()).toBeNull();
    vi.unstubAllEnvs();
  });

  it("returns null when env var is not set", () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    expect(readEnvToken()).toBeNull();
  });
});

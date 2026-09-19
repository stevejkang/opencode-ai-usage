import type { ProviderDefinition } from "../../types";
import type { ClaudeExtras } from "./types";
import { detect, fetchUsage } from "./fetcher";

/** Factory for the Claude OAuth provider. */
export function createClaudeProvider(): ProviderDefinition<ClaudeExtras> {
  return {
    id: "claude",
    displayName: "Claude Usage",
    defaultHeaderColor: "#E07A3A",
    expectedLoadTimeS: 8,
    defaultRefreshIntervalS: 60,
    detect,
    fetch: fetchUsage,
  };
}

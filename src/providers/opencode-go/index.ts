import type { ProviderDefinition } from "../../types";
import { detect, fetchUsage } from "./fetcher";

export function createOpenCodeGoProvider(): ProviderDefinition<null> {
  return {
    id: "opencode-go",
    displayName: "OpenCode Go Usage",
    defaultHeaderColor: "#FDFCFC",
    expectedLoadTimeS: 10,
    defaultRefreshIntervalS: 60,
    detect,
    fetch: fetchUsage,
  };
}

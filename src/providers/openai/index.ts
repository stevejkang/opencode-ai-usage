import type { ProviderDefinition } from "../../types";
import { detect, fetchUsage } from "./fetcher";

/** Create the OpenAI provider backed by Codex CLI JSON-RPC. */
export function createOpenAIProvider(): ProviderDefinition<null> {
  return {
    id: "openai",
    displayName: "OpenAI Usage",
    defaultHeaderColor: "#10A37F",
    expectedLoadTimeS: 16,
    defaultRefreshIntervalS: 30,
    detect,
    fetch: fetchUsage,
  };
}

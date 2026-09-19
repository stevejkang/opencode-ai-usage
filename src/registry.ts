import type { ProviderDefinition } from "./types";

export interface Registry {
  getAll(): ProviderDefinition<unknown>[];
  getEnabled(disabledProviders?: string[]): ProviderDefinition<unknown>[];
}

export function createRegistry(providers: ProviderDefinition<unknown>[]): Registry {
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider.id)) {
      throw new Error(`Duplicate provider id: ${provider.id}`);
    }
    seen.add(provider.id);
  }

  const frozen = [...providers];

  return {
    getAll() {
      return [...frozen];
    },
    getEnabled(disabledProviders?: string[]) {
      if (!disabledProviders || disabledProviders.length === 0) {
        return [...frozen];
      }
      const disabled = new Set(disabledProviders);
      return frozen.filter((p) => !disabled.has(p.id));
    },
  };
}

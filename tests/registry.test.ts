import { createRegistry } from "../src/registry";
import type { ProviderDefinition } from "../src/types";

function stubProvider(id: string): ProviderDefinition<unknown> {
  return {
    id,
    displayName: id,
    defaultHeaderColor: "#000000",
    expectedLoadTimeS: 10,
    defaultRefreshIntervalS: 60,
    detect: async () => ({ available: true }),
    fetch: async () => ({
      accountKey: null,
      windows: [],
      profile: null,
      extras: null,
    }),
  };
}

describe("createRegistry", () => {
  it("getAll returns all registered providers", () => {
    const reg = createRegistry([stubProvider("a"), stubProvider("b")]);
    expect(reg.getAll()).toHaveLength(2);
    expect(reg.getAll().map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("getEnabled filters blacklisted ids", () => {
    const reg = createRegistry([stubProvider("a"), stubProvider("b"), stubProvider("c")]);
    const enabled = reg.getEnabled(["b"]);
    expect(enabled).toHaveLength(2);
    expect(enabled.map((p) => p.id)).toEqual(["a", "c"]);
  });

  it("getEnabled with undefined or empty blacklist returns all", () => {
    const reg = createRegistry([stubProvider("a"), stubProvider("b")]);
    expect(reg.getEnabled()).toHaveLength(2);
    expect(reg.getEnabled(undefined)).toHaveLength(2);
    expect(reg.getEnabled([])).toHaveLength(2);
  });

  it("empty registry works", () => {
    const reg = createRegistry([]);
    expect(reg.getAll()).toHaveLength(0);
    expect(reg.getEnabled()).toHaveLength(0);
  });

  it("duplicate id registration throws", () => {
    expect(() => createRegistry([stubProvider("a"), stubProvider("a")])).toThrow(
      "Duplicate provider id: a",
    );
  });

  it("no shared mutable state between two createRegistry calls", () => {
    const a = createRegistry([stubProvider("x")]);
    const b = createRegistry([stubProvider("y")]);
    expect(a.getAll().map((p) => p.id)).toEqual(["x"]);
    expect(b.getAll().map((p) => p.id)).toEqual(["y"]);
  });
});

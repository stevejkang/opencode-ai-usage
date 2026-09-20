/** @jsxImportSource @opentui/solid */
import { execSync, execFileSync, spawn as nodeSpawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir as osHomedir } from "node:os";
import { createSignal, onMount } from "solid-js";
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui";
import type { ColorInput } from "@opentui/core";
import type {
  DisplayMode,
  PluginOptions,
  ProviderDefinition,
  ProviderDeps,
  RefreshState,
  TuiTheme,
  UsageWindow,
} from "./types";
import { toPercent } from "./types";
import { createRegistry } from "./registry";
import { createRefreshLoop } from "./refresh";
import { createCacheStore } from "./cache";
import {
  formatBar,
  formatCreditDisplay,
  formatPercentage,
  formatRelativeTime,
  getPercentColor,
} from "./format";
import { createClaudeProvider } from "./providers/claude";
import { createOpenAIProvider } from "./providers/openai";
import { createOpenCodeGoProvider } from "./providers/opencode-go";

import { computeDisplayPercent, computeSectionVisibility } from "./tui-logic";

export {
  computeSectionVisibility,
  computeStaleText,
  computeDisplayPercent,
  computeCountdown,
} from "./tui-logic";
export type { SectionVisibility } from "./tui-logic";

const THIN_FILLED = "━";
const THIN_EMPTY = "─";
const VALUE_COLOR = "#82AAFF";

function ThinBar(props: { progress: number; filledColor: ColorInput; emptyColor: ColorInput }) {
  let ref!: any;
  const [width, setWidth] = createSignal(0);

  const measure = () => {
    setImmediate(() => {
      if (ref?.getLayoutNode) {
        setWidth(ref.getLayoutNode().getComputedWidth());
      }
    });
  };

  onMount(measure);

  const filled = () => Math.floor(width() * Math.max(0, Math.min(1, props.progress)));
  const remaining = () => width() - filled();

  return (
    <box height={1} flexGrow={1} ref={ref} flexDirection="row" onSizeChange={measure}>
      <text fg={props.filledColor} width={filled()}>
        {THIN_FILLED.repeat(filled())}
      </text>
      <text fg={props.emptyColor} width={remaining()}>
        {THIN_EMPTY.repeat(remaining())}
      </text>
    </box>
  );
}

interface CreditShape {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  currency: string | null;
}

function extractCreditExtras(extras: unknown): CreditShape | null {
  if (extras === null || typeof extras !== "object") return null;
  if (!("extraUsage" in extras)) return null;
  const eu = (extras as Record<string, unknown>).extraUsage;
  if (eu === null || typeof eu !== "object") return null;
  if (!("isEnabled" in (eu as Record<string, unknown>))) return null;
  const shaped = eu as CreditShape;
  if (!shaped.isEnabled) return null;
  return shaped;
}

interface ProviderRuntime {
  provider: ProviderDefinition<unknown>;
  detected: boolean;
  state: () => RefreshState;
  open: () => boolean;
  toggleOpen: () => void;
  countdown: () => number;
  refreshIntervalMs: number;
  headerColor: string;
}

function renderWindowRow(
  w: UsageWindow,
  mode: DisplayMode,
  showRemaining: boolean,
  fg: ColorInput,
  dim: ColorInput,
  pad: number,
) {
  const displayPct = computeDisplayPercent(w.percent, showRemaining);
  const pctColor = !w.isActive ? dim : getPercentColor(displayPct, VALUE_COLOR, showRemaining);
  const resetStr = formatRelativeTime(w.resetsAt);
  const hasReset = resetStr !== "—";

  if (!w.isActive) {
    if (mode === "mixed") {
      return (
        <box flexDirection="column">
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={fg}>{` ${w.label}`}</text>
            <text fg={dim}>{"inactive"}</text>
          </box>
          <box height={1} flexDirection="row">
            <text fg={dim}> </text>
            <ThinBar progress={0} filledColor={dim} emptyColor={dim} />
            <text fg={dim}>{` ${formatPercentage(toPercent(0)).padStart(4)}`}</text>
          </box>
        </box>
      );
    }
    if (mode === "bar") {
      const bar = formatBar(toPercent(0));
      return (
        <box height={1} flexDirection="row">
          <box width={pad + 1}>
            <text fg={fg}>{` ${w.label}`}</text>
          </box>
          <text
            fg={dim}
          >{`${bar.filled}${bar.empty}${formatPercentage(toPercent(0)).padStart(4)} inactive`}</text>
        </box>
      );
    }
    return (
      <box height={1} flexDirection="row">
        <box width={pad + 1}>
          <text fg={fg}>{` ${w.label}`}</text>
        </box>
        <text fg={dim}>{`${formatPercentage(toPercent(0)).padStart(5)}  inactive`}</text>
      </box>
    );
  }

  const progress = (displayPct ?? 0) / 100;

  if (mode === "mixed") {
    const resetSuffix = hasReset ? `resets in ${resetStr}` : "";
    return (
      <box flexDirection="column">
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={fg}>{` ${w.label}`}</text>
          <text fg={dim}>{resetSuffix}</text>
        </box>
        <box height={1} flexDirection="row">
          <text> </text>
          <ThinBar progress={progress} filledColor={pctColor} emptyColor={dim} />
          <text fg={pctColor}>{` ${formatPercentage(displayPct).padStart(4)}`}</text>
        </box>
      </box>
    );
  }

  if (mode === "bar") {
    const bar = formatBar(displayPct);
    const resetSuffix = hasReset ? ` (${resetStr})` : "";
    return (
      <box height={1} flexDirection="row">
        <box width={pad + 1}>
          <text fg={fg}>{` ${w.label}`}</text>
        </box>
        <text
          fg={pctColor}
        >{`${bar.filled}${bar.empty}${formatPercentage(displayPct).padStart(4)}`}</text>
        <text fg={dim}>{resetSuffix}</text>
      </box>
    );
  }

  return (
    <box height={1} flexDirection="row">
      <box width={pad + 1}>
        <text fg={fg}>{` ${w.label}`}</text>
      </box>
      <text fg={pctColor}>{formatPercentage(displayPct).padStart(5)}</text>
      <text fg={dim}>{hasReset ? `  resets in ${resetStr}` : ""}</text>
    </box>
  );
}

function renderCreditRow(
  credit: CreditShape,
  mode: DisplayMode,
  showRemaining: boolean,
  fg: ColorInput,
  dim: ColorInput,
  pad: number,
) {
  const display = formatCreditDisplay(credit.usedCredits, credit.monthlyLimit, credit.currency);
  if (!display) return null;

  const creditPct = display.isInactive ? toPercent(0) : toPercent(display.percent);
  const displayPct = computeDisplayPercent(creditPct, showRemaining);
  const creditColor = display.isInactive
    ? dim
    : getPercentColor(displayPct, VALUE_COLOR, showRemaining);

  if (display.isInactive) {
    if (mode === "mixed") {
      return (
        <box flexDirection="column">
          <box height={1} flexDirection="row" justifyContent="space-between">
            <text fg={fg}>{" Credit"}</text>
            <text fg={dim}>{"inactive"}</text>
          </box>
          <box height={1} flexDirection="row">
            <text fg={dim}> </text>
            <ThinBar progress={0} filledColor={dim} emptyColor={dim} />
            <text fg={dim}>{` ${formatPercentage(toPercent(0)).padStart(4)}`}</text>
          </box>
        </box>
      );
    }
    if (mode === "bar") {
      const bar = formatBar(toPercent(0));
      return (
        <box height={1} flexDirection="row">
          <box width={pad + 1}>
            <text fg={fg}>{" Credit"}</text>
          </box>
          <text
            fg={dim}
          >{`${bar.filled}${bar.empty}${formatPercentage(toPercent(0)).padStart(4)} inactive`}</text>
        </box>
      );
    }
    return (
      <box height={1} flexDirection="row">
        <box width={pad + 1}>
          <text fg={fg}>{" Credit"}</text>
        </box>
        <text fg={dim}>{`${formatPercentage(toPercent(0)).padStart(5)}  inactive`}</text>
      </box>
    );
  }

  const progress = Math.min((displayPct ?? 0) / 100, 1);

  if (mode === "mixed") {
    return (
      <box flexDirection="column">
        <box height={1} flexDirection="row" justifyContent="space-between">
          <text fg={fg}>{" Credit"}</text>
          <text fg={dim}>{`${display.remainingStr} left`}</text>
        </box>
        <box height={1} flexDirection="row">
          <text> </text>
          <ThinBar progress={progress} filledColor={creditColor} emptyColor={dim} />
          <text fg={creditColor}>{` ${formatPercentage(displayPct).padStart(4)}`}</text>
        </box>
      </box>
    );
  }

  if (mode === "bar") {
    const bar = formatBar(displayPct);
    return (
      <box height={1} flexDirection="row">
        <box width={pad + 1}>
          <text fg={fg}>{" Credit"}</text>
        </box>
        <text
          fg={creditColor}
        >{`${bar.filled}${bar.empty}${formatPercentage(displayPct).padStart(4)}`}</text>
        <text fg={dim}>{` (${display.remainingStr})`}</text>
      </box>
    );
  }

  return (
    <box height={1} flexDirection="row">
      <box width={pad + 1}>
        <text fg={fg}>{" Credit"}</text>
      </box>
      <text fg={creditColor}>{display.usedStr}</text>
      <text fg={dim}>{`  ${display.remainingStr} left`}</text>
    </box>
  );
}

const tui: TuiPlugin = async (api, rawOptions, _meta) => {
  const options = (rawOptions as PluginOptions | undefined) ?? {};
  const displayMode: DisplayMode = options.displayMode ?? "mixed";
  const showRemaining = options.showRemaining ?? false;

  const deps: ProviderDeps = {
    exec: execSync,
    execFile: execFileSync,
    spawn: nodeSpawn,
    readFile: readFileSync,
    fetch: globalThis.fetch,
    now: Date.now,
    homedir: osHomedir,
  };

  const cache = createCacheStore();
  const registry = createRegistry([
    createClaudeProvider(),
    createOpenAIProvider(),
    createOpenCodeGoProvider(),
  ]);
  const enabled = registry.getEnabled(options.disabledProviders);

  const controller = new AbortController();
  const { signal } = controller;
  const tickTimers: (ReturnType<typeof setInterval> | null)[] = [];
  const runtimes: ProviderRuntime[] = [];

  for (const provider of enabled) {
    let detected = false;
    try {
      const result = await provider.detect(deps, signal);
      detected = result.available;
    } catch {
      detected = false;
    }

    const overrides = options.providers?.[provider.id];
    const refreshIntervalMs =
      (overrides?.refreshInterval ?? provider.defaultRefreshIntervalS) * 1000;
    const headerColor = overrides?.headerColor ?? provider.defaultHeaderColor;

    const [state, rawSetState] = createSignal<RefreshState>({
      windows: [],
      profile: null,
      extras: null,
      error: null,
      lastFetchedAt: null,
    });
    const [open, setOpen] = createSignal(true);
    const [countdown, setCountdown] = createSignal(provider.expectedLoadTimeS);

    const idx = tickTimers.length;
    tickTimers.push(null);

    if (detected) {
      tickTimers[idx] = setInterval(() => {
        setCountdown((prev) => Math.max(0, prev - 1));
      }, 1000);

      const setState = (s: RefreshState) => {
        if (s.lastFetchedAt !== null || s.error !== null) {
          if (tickTimers[idx]) {
            clearInterval(tickTimers[idx]!);
            tickTimers[idx] = null;
          }
        }
        rawSetState(s);
      };

      createRefreshLoop({ provider, deps, cache, signal, intervalMs: refreshIntervalMs, setState });
    }

    runtimes.push({
      provider,
      detected,
      state,
      open,
      toggleOpen: () => setOpen((prev) => !prev),
      countdown,
      refreshIntervalMs,
      headerColor,
    });
  }

  api.lifecycle.onDispose(() => {
    controller.abort();
    for (const timer of tickTimers) {
      if (timer) clearInterval(timer);
    }
  });

  api.slots.register({
    order: 60,
    slots: {
      // opentui-ref-carveout: sidebar_content slot return type incompatible with @opentui/solid JSX
      sidebar_content(ctx: TuiSlotContext, _props: unknown) {
        const t = ctx.theme.current;
        const dim: ColorInput = t.textMuted ?? "#546E7A";
        const fg: ColorInput = t.text ?? "#EEFFFF";

        const active = runtimes.filter((r) => r.detected);

        const content =
          active.length === 0 ? null : (
            <box flexDirection="column">
              {active.map((rt, idx) => {
                const s = rt.state();
                const now = Date.now();
                const vis = computeSectionVisibility({
                  hasData: s.lastFetchedAt !== null,
                  error: s.error,
                  lastFetchedAt: s.lastFetchedAt,
                  refreshIntervalMs: rt.refreshIntervalMs,
                  now,
                });
                const isOpen = rt.open();

                const header = (
                  <box height={1} flexDirection="row" onMouseDown={rt.toggleOpen}>
                    <text fg={rt.headerColor}>
                      <b>
                        {isOpen ? "\u25BC" : "\u25B6"} {rt.provider.displayName}
                      </b>
                    </text>
                    {vis.kind === "data" && vis.staleText ? (
                      <text fg={dim}>{`  ${vis.staleText}`}</text>
                    ) : null}
                  </box>
                );

                if (vis.kind === "loading") {
                  const cd = rt.countdown();
                  const msg = cd > 0 ? `Loading in ${cd}s...` : "Loading shortly...";
                  return (
                    <box flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
                      {header}
                      {isOpen ? (
                        <box height={1}>
                          <text fg={dim}>{` ${msg}`}</text>
                        </box>
                      ) : null}
                    </box>
                  );
                }

                if (vis.kind === "error") {
                  return (
                    <box flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
                      {header}
                      {isOpen ? (
                        <box height={1}>
                          <text fg={dim}>{" Failed to fetch usage"}</text>
                        </box>
                      ) : null}
                    </box>
                  );
                }

                const windows = s.windows;
                const profile = s.profile;
                const creditExtras = extractCreditExtras(s.extras);

                const allLabels = windows.map((w) => w.label);
                if (creditExtras) allLabels.push("Credit");
                const maxLen =
                  allLabels.length > 0 ? Math.max(...allLabels.map((l) => l.length)) : 0;
                const pad =
                  displayMode === "bar" ? Math.max(maxLen + 1, 8) : Math.max(maxLen + 2, 9);

                return (
                  <box flexDirection="column" marginTop={idx > 0 ? 1 : 0}>
                    {header}
                    {isOpen ? (
                      <box flexDirection="column">
                        {profile?.email ? (
                          <box height={1}>
                            <text fg={dim}>{` ${profile.email}`}</text>
                          </box>
                        ) : null}

                        {windows.map((w) =>
                          renderWindowRow(w, displayMode, showRemaining, fg, dim, pad),
                        )}

                        {creditExtras
                          ? renderCreditRow(creditExtras, displayMode, showRemaining, fg, dim, pad)
                          : null}

                        {rt.provider.renderExpanded
                          ? rt.provider.renderExpanded(
                              {
                                theme: { text: fg, textMuted: dim } as unknown as TuiTheme,
                                options,
                              },
                              s.extras,
                            )
                          : null}
                      </box>
                    ) : null}
                  </box>
                );
              })}
            </box>
          );

        return content as any;
      },
    },
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-ai-usage",
  tui,
};

export default plugin;

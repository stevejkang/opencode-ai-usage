/** @jsxImportSource @opentui/solid */
import type { TuiPlugin, TuiPluginModule, TuiSlotContext } from "@opencode-ai/plugin/tui";

const tui: TuiPlugin = async (api, _options, _meta) => {
  api.slots.register({
    order: 60,
    slots: {
      // opentui-ref-carveout: sidebar_content slot return type incompatible with @opentui/solid JSX
      sidebar_content(_ctx: TuiSlotContext, _props: unknown) {
        return (<text>Hello</text>) as any;
      },
    },
  });
};

const plugin: TuiPluginModule & { id: string } = {
  id: "opencode-ai-usage",
  tui,
};

export default plugin;
